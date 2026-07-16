import {
  CONFIG,
  processIdentity,
  type DisplayDeviceSample,
  type NvidiaAdapterSample,
  type ProcessSample,
  type SourceHealth,
  type Sources,
  type SystemSample,
} from "./model.ts";

export interface CollectorIssue {
  source: string;
  errorCode: string;
  message: string;
}

export interface RawCollectorSample {
  timestampUtc: string;
  monotonicMs: number;
  intervalMs: number;
  system: SystemSample;
  nvidia: readonly NvidiaAdapterSample[];
  displays: readonly DisplayDeviceSample[];
  processes: readonly ProcessSample[] | null;
  processInventoryFresh: boolean;
  sources: Sources;
  issues: readonly CollectorIssue[];
}

export interface CollectorOptions {
  sampleIntervalMs?: number;
  processIntervalMs?: number;
  powershellCommand?: string;
  nvidiaCommand?: string;
}

export interface CollectorHandle {
  samples: AsyncIterable<RawCollectorSample>;
  stop(reason: string): Promise<void>;
}

interface PowerShellRecord {
  timestampUtc: string;
  monotonicMs: number;
  intervalMs: number;
  system: SystemSample;
  displays: DisplayDeviceSample[];
  processes: Omit<ProcessSample, "identity" | "self">[] | null;
  processInventoryFresh: boolean;
  sources: Sources;
  issues?: CollectorIssue[];
}

interface NvidiaState {
  adapters: NvidiaAdapterSample[];
  health: SourceHealth;
}

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$sampleMs = [int]$env:RAM_PROBE_SAMPLE_MS
$processEvery = [Math]::Max(1, [int]([int]$env:RAM_PROBE_PROCESS_MS / $sampleMs))
$logicalProcessors = [Environment]::ProcessorCount
$clock = [Diagnostics.Stopwatch]::StartNew()
$nextDue = 0L
$previous = 0L
$tick = 0

function Health($state, $latency, $code = $null, $message = $null) {
  [ordered]@{ state=$state; latencyMs=$latency; ageMs=0; exitCode=$null; errorCode=$code; message=$message }
}
function NullableNumber($value) {
  if ($null -eq $value) { return $null }
  return [double]$value
}
function BytesFromKb($value) {
  if ($null -eq $value) { return $null }
  return [double]$value * 1024
}
function SumOrNull($values) {
  $valid = @($values | Where-Object { $null -ne $_ })
  if ($valid.Count -eq 0) { return $null }
  return [double](($valid | Measure-Object -Sum).Sum)
}

while ($true) {
  $now = $clock.ElapsedMilliseconds
  if ($now -lt $nextDue) { Start-Sleep -Milliseconds ([int]($nextDue - $now)) }
  $started = $clock.ElapsedMilliseconds
  $interval = if ($tick -eq 0) { $sampleMs } else { $started - $previous }
  $previous = $started
  $freshProcesses = ($tick % $processEvery) -eq 0
  $sources = [ordered]@{}
  $issues = [Collections.Generic.List[object]]::new()
  $system = [ordered]@{
    totalPhysicalBytes=$null; availablePhysicalBytes=$null; usedPhysicalPercent=$null
    committedBytes=$null; commitLimitBytes=$null
    pagefileAllocatedBytes=$null; pagefileCurrentBytes=$null; pagefilePeakBytes=$null
    compressionWorkingSetBytes=$null; cacheBytes=$null
    pagedPoolAllocatedBytes=$null; pagedPoolResidentBytes=$null; nonpagedPoolBytes=$null
    pageInputsPerSecond=$null; pageReadsPerSecond=$null; cpuHostPercent=$null
    diskBusyPercent=$null; diskReadBytesPerSecond=$null; diskWriteBytesPerSecond=$null; diskQueueLength=$null
    wddmDedicatedBytes=$null; wddmSharedBytes=$null; dwmWddmBytes=$null; slackWddmBytes=$null
    vmmemWslWorkingSetBytes=$null; wslState=$null; herdrState=$null
  }
  $displays = @()
  $processes = $null

  $queryClock = [Diagnostics.Stopwatch]::StartNew()
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
    $disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
    $pagefile = @(Get-CimInstance Win32_PageFileUsage)
    $total = BytesFromKb $os.TotalVisibleMemorySize
    $available = BytesFromKb $os.FreePhysicalMemory
    $system.totalPhysicalBytes = $total
    $system.availablePhysicalBytes = $available
    $system.usedPhysicalPercent = if ($total -gt 0) { (($total - $available) / $total) * 100 } else { $null }
    $system.committedBytes = [double]$memory.CommittedBytes
    $system.commitLimitBytes = [double]$memory.CommitLimit
    $system.cacheBytes = [double]$memory.CacheBytes
    $system.pagedPoolAllocatedBytes = [double]$memory.PoolPagedBytes
    $system.pagedPoolResidentBytes = [double]$memory.PoolPagedResidentBytes
    $system.nonpagedPoolBytes = [double]$memory.PoolNonpagedBytes
    $system.pageInputsPerSecond = [double]$memory.PageInputPersec
    $system.pageReadsPerSecond = [double]$memory.PageReadsPersec
    $system.cpuHostPercent = [double]$cpu.PercentProcessorTime
    $system.diskBusyPercent = [double]$disk.PercentDiskTime
    $system.diskReadBytesPerSecond = [double]$disk.DiskReadBytesPersec
    $system.diskWriteBytesPerSecond = [double]$disk.DiskWriteBytesPersec
    $system.diskQueueLength = [double]$disk.CurrentDiskQueueLength
    $system.pagefileAllocatedBytes = SumOrNull @($pagefile | ForEach-Object { [double]$_.AllocatedBaseSize * 1MB })
    $system.pagefileCurrentBytes = SumOrNull @($pagefile | ForEach-Object { [double]$_.CurrentUsage * 1MB })
    $system.pagefilePeakBytes = SumOrNull @($pagefile | ForEach-Object { [double]$_.PeakUsage * 1MB })
    $sources.cim = Health 'ok' $queryClock.ElapsedMilliseconds
  } catch {
    $sources.cim = Health 'error' $queryClock.ElapsedMilliseconds 'cim-query' $_.Exception.Message
    $issues.Add([ordered]@{source='cim'; errorCode='cim-query'; message=$_.Exception.Message})
  }

  $gpuClock = [Diagnostics.Stopwatch]::StartNew()
  $gpuByPid = @{}
  try {
    $gpuRows = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction Stop)
    foreach ($row in $gpuRows) {
      if ($row.Name -match 'pid_(\d+)') {
        $id = [int]$Matches[1]
        if (-not $gpuByPid.ContainsKey($id)) { $gpuByPid[$id] = [ordered]@{dedicated=0.0; shared=0.0} }
        $gpuByPid[$id].dedicated += [double]$row.DedicatedUsage
        $gpuByPid[$id].shared += [double]$row.SharedUsage
      }
    }
    $system.wddmDedicatedBytes = SumOrNull @($gpuRows | ForEach-Object { $_.DedicatedUsage })
    $system.wddmSharedBytes = SumOrNull @($gpuRows | ForEach-Object { $_.SharedUsage })
    $sources.wddm = Health 'ok' $gpuClock.ElapsedMilliseconds
  } catch {
    $sources.wddm = Health 'unavailable' $gpuClock.ElapsedMilliseconds 'wddm-query' $_.Exception.Message
  }

  $procClock = [Diagnostics.Stopwatch]::StartNew()
  try {
    $perfRows = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -gt 0 })
    $dwmRows = @($perfRows | Where-Object Name -eq 'dwm')
    $slackRows = @($perfRows | Where-Object { $_.Name -like 'slack*' })
    $vmmemRows = @($perfRows | Where-Object Name -eq 'vmmemWSL')
    $compressionRows = @($perfRows | Where-Object Name -eq 'Memory Compression')
    $system.dwmWddmBytes = SumOrNull @($dwmRows | ForEach-Object { if ($gpuByPid.ContainsKey([int]$_.IDProcess)) { $gpuByPid[[int]$_.IDProcess].dedicated + $gpuByPid[[int]$_.IDProcess].shared } })
    $system.slackWddmBytes = SumOrNull @($slackRows | ForEach-Object { if ($gpuByPid.ContainsKey([int]$_.IDProcess)) { $gpuByPid[[int]$_.IDProcess].dedicated + $gpuByPid[[int]$_.IDProcess].shared } })
    $system.vmmemWslWorkingSetBytes = SumOrNull @($vmmemRows | ForEach-Object { $_.WorkingSetPrivate })
    $system.compressionWorkingSetBytes = SumOrNull @($compressionRows | ForEach-Object { $_.WorkingSet })

    if ($freshProcesses) {
      $inventory = @{}
      foreach ($item in @(Get-CimInstance Win32_Process)) { $inventory[[int]$item.ProcessId] = $item }
      $processes = @($perfRows | ForEach-Object {
        $id = [int]$_.IDProcess
        $info = $inventory[$id]
        $created = if ($null -ne $info -and $null -ne $info.CreationDate) { $info.CreationDate.ToUniversalTime().ToString('o') } else { $null }
        $gpu = $gpuByPid[$id]
        [ordered]@{
          pid=$id; parentPid=if ($null -ne $info) { [int]$info.ParentProcessId } else { $null }
          creationUtc=$created; name=[string]$_.Name
          executablePath=if ($null -ne $info) { $info.ExecutablePath } else { $null }
          commandLine=if ($null -ne $info) { $info.CommandLine } else { $null }
          privateBytes=NullableNumber $_.PrivateBytes
          privateWorkingSetBytes=NullableNumber $_.WorkingSetPrivate
          workingSetBytes=NullableNumber $_.WorkingSet
          cpuCorePercent=NullableNumber $_.PercentProcessorTime
          cpuHostPercent=if ($null -ne $_.PercentProcessorTime) { [double]$_.PercentProcessorTime / $logicalProcessors } else { $null }
          ioBytesPerSecond=if ($null -ne $_.IODataBytesPersec) { [double]$_.IODataBytesPersec } else { $null }
          threadCount=NullableNumber $_.ThreadCount
          handleCount=NullableNumber $_.HandleCount
          wddmDedicatedBytes=if ($null -ne $gpu) { [double]$gpu.dedicated } else { $null }
          wddmSharedBytes=if ($null -ne $gpu) { [double]$gpu.shared } else { $null }
        }
      })
    }
    $sources.process = Health 'ok' $procClock.ElapsedMilliseconds
  } catch {
    $sources.process = Health 'partial' $procClock.ElapsedMilliseconds 'process-query' $_.Exception.Message
    $issues.Add([ordered]@{source='process'; errorCode='process-query'; message=$_.Exception.Message})
  }

  if ($freshProcesses) {
    $deviceClock = [Diagnostics.Stopwatch]::StartNew()
    try {
      $displays = @(Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Display'" | ForEach-Object {
        $code = if ($null -eq $_.ConfigManagerErrorCode) { $null } else { [int]$_.ConfigManagerErrorCode }
        [ordered]@{ name=[string]$_.Name; status=$_.Status; errorCode=$code; informational=($code -eq 22 -and $_.Name -like '*AMD Radeon*') }
      })
      $sources.display = Health 'ok' $deviceClock.ElapsedMilliseconds
    } catch {
      $sources.display = Health 'partial' $deviceClock.ElapsedMilliseconds 'display-query' $_.Exception.Message
    }
    try {
      $runningWsl = @(& wsl.exe --list --running --quiet 2>$null | Where-Object { $_.Trim() })
      $system.wslState = if ($runningWsl.Count -gt 0) { 'running: ' + ($runningWsl -join ', ') } else { 'stopped' }
      $sources.wsl = Health 'ok' $null
    } catch {
      $system.wslState = 'unknown'
      $sources.wsl = Health 'unavailable' $null 'wsl-query' $_.Exception.Message
    }
    try {
      $service = Get-Service -Name Herdr -ErrorAction Stop
      $system.herdrState = [string]$service.Status
      $sources.herdr = Health 'ok' $null
    } catch {
      $system.herdrState = 'unknown'
      $sources.herdr = Health 'unavailable' $null 'herdr-missing' 'Herdr service not installed or inaccessible'
    }
  }

  [ordered]@{
    timestampUtc=[DateTime]::UtcNow.ToString('o'); monotonicMs=[double]$started; intervalMs=[double]$interval
    system=$system; displays=$displays; processes=$processes; processInventoryFresh=$freshProcesses
    sources=$sources; issues=@($issues)
  } | ConvertTo-Json -Compress -Depth 8 | Write-Output

  $tick++
  $nextDue += $sampleMs
  if ($clock.ElapsedMilliseconds -gt $nextDue + $sampleMs) { $nextDue = $clock.ElapsedMilliseconds }
}
`;

const unavailableHealth = (code: string, message: string): SourceHealth => ({
  state: "unavailable",
  latencyMs: null,
  ageMs: null,
  exitCode: null,
  errorCode: code,
  message,
});

async function* lines(stream: ReadableStream<Uint8Array<ArrayBuffer>>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        yield pending.slice(0, index).replace(/\r$/, "");
        pending = pending.slice(index + 1);
      }
      if (pending.length > 8_388_608) pending = "";
    }
    pending += decoder.decode();
    if (pending) yield pending.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

function parseNvidia(line: string): NvidiaAdapterSample | null {
  const fields = line.split(",").map((value) => value.trim());
  if (fields.length < 14 || !fields[0]) return null;
  const number = (value: string | undefined, scale = 1): number | null => {
    if (!value || value === "N/A" || value === "[Not Supported]") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed * scale : null;
  };
  return {
    uuid: fields[0],
    name: fields[1] || null,
    totalVramBytes: number(fields[2], 1024 ** 2),
    usedVramBytes: number(fields[3], 1024 ** 2),
    freeVramBytes: number(fields[4], 1024 ** 2),
    utilizationPercent: number(fields[5]),
    temperatureCelsius: number(fields[6]),
    powerWatts: number(fields[7]),
    graphicsClockMhz: number(fields[8]),
    memoryClockMhz: number(fields[9]),
    pState: fields[10] || null,
    pciBusId: fields[11] || null,
    driverVersion: fields[12] || null,
  };
}

export function startCollector(options: CollectorOptions = {}): CollectorHandle {
  const sampleIntervalMs = options.sampleIntervalMs ?? CONFIG.sampleIntervalMs;
  const processIntervalMs = options.processIntervalMs ?? CONFIG.processIntervalMs;
  const powershellCommand = options.powershellCommand ?? "powershell.exe";
  const nvidiaCommand = options.nvidiaCommand ?? "nvidia-smi.exe";
  const issues: CollectorIssue[] = [];
  const addIssue = (issue: CollectorIssue): void => {
    if (issues.length < 100) issues.push(issue);
  };
  let stopped = false;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const pendingWake = wake;
    wake = undefined;
    if (pendingWake) pendingWake();
  };
  const queue: RawCollectorSample[] = [];
  let nvidia: NvidiaState = {
    adapters: [],
    health: { ...unavailableHealth("nvidia-starting", "Awaiting first NVIDIA sample"), state: "partial" },
  };

  const powershell = Bun.spawn(
    [powershellCommand, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "& ([ScriptBlock]::Create($env:RAM_PROBE_SCRIPT))"],
    {
      env: {
        ...process.env,
        RAM_PROBE_SCRIPT: POWERSHELL_SCRIPT,
        RAM_PROBE_SAMPLE_MS: String(sampleIntervalMs),
        RAM_PROBE_PROCESS_MS: String(processIntervalMs),
      },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  );

  let nvidiaProcess: Bun.ReadableSubprocess | null = null;
  try {
    nvidiaProcess = Bun.spawn(
      [
        nvidiaCommand,
        "--query-gpu=uuid,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw,clocks.gr,clocks.mem,pstate,pci.bus_id,driver_version,timestamp",
        "--format=csv,noheader,nounits",
        `--loop-ms=${sampleIntervalMs}`,
      ],
      { stdout: "pipe", stderr: "pipe", windowsHide: true },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    nvidia = { adapters: [], health: unavailableHealth("nvidia-spawn", message) };
    addIssue({ source: "nvidia", errorCode: "nvidia-spawn", message });
  }

  const selfPids = (): Set<number> =>
    new Set([process.pid, powershell.pid, nvidiaProcess?.pid].filter((pid): pid is number => typeof pid === "number"));

  const powershellTask = (async () => {
    for await (const line of lines(powershell.stdout)) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as PowerShellRecord;
        if (!record.timestampUtc || !record.system || !record.sources) throw new Error("missing required fields");
        const own = selfPids();
        const processes = record.processes?.map((item) => ({
          ...item,
          identity: processIdentity(item.pid, item.creationUtc),
          self: own.has(item.pid),
        })) ?? null;
        const pendingIssues = [...(record.issues ?? []), ...issues.splice(0)];
        if (queue.length >= 32) {
          queue.shift();
          pendingIssues.push({ source: "collector", errorCode: "sample-queue-overflow", message: "Oldest pending sample dropped" });
        }
        const sample: RawCollectorSample = {
          ...record,
          processes,
          nvidia: nvidia.adapters,
          sources: { ...record.sources, nvidia: nvidia.health },
          issues: pendingIssues,
        };
        queue.push(sample);
        notify();
      } catch (error) {
        addIssue({
          source: "powershell",
          errorCode: "malformed-json",
          message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
        });
      }
    }
    const exitCode = await powershell.exited;
    if (!stopped) {
      addIssue({ source: "powershell", errorCode: "collector-exit", message: `PowerShell collector exited with ${exitCode}` });
      notify();
    }
  })();

  if (nvidiaProcess) {
    const child = nvidiaProcess;
    void (async () => {
      for await (const line of lines(child.stdout)) {
        const parsed = parseNvidia(line);
        if (!parsed) {
          if (line) addIssue({ source: "nvidia", errorCode: "malformed-line", message: line.slice(0, 512) });
          continue;
        }
        nvidia = {
          adapters: [parsed],
          health: { state: "ok", latencyMs: null, ageMs: 0, exitCode: null, errorCode: null, message: null },
        };
      }
      const exitCode = await child.exited;
      if (!stopped) {
        nvidia = {
          adapters: [],
          health: { ...unavailableHealth("nvidia-exit", `nvidia-smi exited with ${exitCode}`), exitCode },
        };
        addIssue({ source: "nvidia", errorCode: "nvidia-exit", message: `nvidia-smi exited with ${exitCode}` });
      }
    })();
  }

  void (async () => {
    for await (const line of lines(powershell.stderr)) {
      if (line) addIssue({ source: "powershell", errorCode: "stderr", message: line.slice(0, 512) });
    }
  })();
  if (nvidiaProcess) {
    void (async () => {
      for await (const _line of lines(nvidiaProcess.stderr)) {
        // Exit health below records one bounded NVIDIA transition.
      }
    })();
  }

  const samples: AsyncIterable<RawCollectorSample> = {
    async *[Symbol.asyncIterator]() {
      while (!stopped) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (powershell.exitCode !== null) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      while (queue.length) yield queue.shift()!;
    },
  };

  return {
    samples,
    async stop(_reason: string): Promise<void> {
      if (stopped) return;
      stopped = true;
      notify();
      powershell.kill();
      nvidiaProcess?.kill();
      await Promise.allSettled([powershell.exited, nvidiaProcess?.exited, powershellTask]);
    },
  };
}
