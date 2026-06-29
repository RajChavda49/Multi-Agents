import { useEffect, useRef } from "react";
import {
  buildPipelineLogEntries,
  formatLogLine,
  logLevelClass,
  pipelineLiveLogLine,
} from "../lib/pipeline-logs.js";

export default function PipelineLogs({ pipeline }) {
  const topRef = useRef(null);
  const entries = buildPipelineLogEntries(pipeline);
  const live = pipelineLiveLogLine(pipeline);

  useEffect(() => {
    topRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length, live?.message, pipeline.updated_at]);

  return (
    <section className="rounded-xl border border-slate-700 bg-slate-950/60 overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-700 bg-slate-900/80 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Pipeline logs
        </h3>
        <span className="text-[10px] text-slate-500 font-mono">{entries.length} lines</span>
      </div>
      <div className="max-h-72 overflow-y-auto p-3 font-mono text-xs leading-relaxed bg-slate-950">
        <div ref={topRef} />
        {entries.length === 0 && !live ? (
          <p className="text-slate-600 italic">No log entries yet.</p>
        ) : (
          <ul className="space-y-1">
            {live && (
              <li className={`${logLevelClass("active")} animate-pulse`}>
                {formatLogLine(live)}
              </li>
            )}
            {entries.map((entry, i) => (
              <li key={`${entry.at}-${i}`} className={logLevelClass(entry.level)}>
                {formatLogLine(entry)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
