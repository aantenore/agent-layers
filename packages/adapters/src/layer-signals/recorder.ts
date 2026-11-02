import { recordingTelemetry, type EvalRun, type RunEvent, type TelemetryPort, type TelemetryRecord } from '@agent-layers/core';

export interface SignalRecorder {
  /** Pass it to `compose(config, { telemetry: [recorder.telemetry] })`. */
  telemetry: TelemetryPort;
  /** Records written since the last `take`, then forgets them. */
  take(): TelemetryRecord[];
  /** The run with the records written since the last `take` appended to its events, ready for `score`. */
  attach(run: EvalRun): EvalRun;
}

/**
 * Captures the telemetry of a run so it can be added to `EvalRun.events` before scoring. Records carry no run id, so
 * take them after each run when runs are sequential, as a dataset run is.
 */
export function createSignalRecorder(): SignalRecorder {
  let records: TelemetryRecord[] = [];
  const take = () => { const out = records; records = []; return out; };
  return {
    telemetry: recordingTelemetry((r) => { records.push(r); }, 'layer-signals-recorder'),
    take,
    // Telemetry records are not run events by type; the scoring reads both kinds from the same list.
    attach: (run) => ({ ...run, events: [...(run.events ?? []), ...(take() as unknown as RunEvent[])] }),
  };
}
