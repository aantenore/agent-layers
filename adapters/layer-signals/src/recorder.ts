import { recordingTelemetry, type TelemetryPort, type TelemetryRecord } from '@agent-layers/core';

export interface SignalRecorder {
  /** Pass it to `compose(config, { telemetry: [recorder.telemetry] })`. */
  telemetry: TelemetryPort;
  /** Records written since the last `take`, then forgets them. */
  take(): TelemetryRecord[];
}

/**
 * Captures the telemetry of a run so it can be added to `EvalRun.events` before scoring. Records carry no run id, so
 * take them after each run when runs are sequential, as a dataset run is.
 */
export function createSignalRecorder(): SignalRecorder {
  let records: TelemetryRecord[] = [];
  return {
    telemetry: recordingTelemetry((r) => { records.push(r); }, 'layer-signals-recorder'),
    take: () => { const out = records; records = []; return out; },
  };
}
