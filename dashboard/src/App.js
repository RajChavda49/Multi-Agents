import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import CreatePipelineForm from "./components/CreatePipelineForm.js";
import JiraTaskList from "./components/JiraTaskList.js";
import PipelineList from "./components/PipelineList.js";
import PipelineDetail from "./components/PipelineDetail.js";

export default function App() {
  const [pipelines, setPipelines] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [jiraConnected, setJiraConnected] = useState(false);
  const [repoConnected, setRepoConnected] = useState(false);
  const [repoSource, setRepoSource] = useState("none");

  const refreshList = useCallback(async () => {
    try {
      const { pipelines: list } = await api.listPipelines();
      setPipelines(list);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const loadDetail = useCallback(async (id) => {
    if (!id) {
      setDetail(null);
      return;
    }
    try {
      const { pipeline } = await api.getPipeline(id);
      setDetail(pipeline);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    Promise.all([
      refreshList(),
      api.jiraStatus().then((s) => setJiraConnected(Boolean(s.connected))).catch(() => {}),
      api.repoStatus()
        .then((s) => {
          setRepoConnected(Boolean(s.connected));
          setRepoSource(s.source || "none");
        })
        .catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [refreshList]);

  useEffect(() => {
    loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    const interval = setInterval(() => {
      refreshList();
      if (selectedId) loadDetail(selectedId);
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedId, refreshList, loadDetail]);

  function handleCreated(pipeline) {
    refreshList();
    setSelectedId(pipeline.id);
  }

  function handleUpdate(pipeline) {
    setDetail(pipeline);
    refreshList();
  }

  async function handleDelete(pipelineId) {
    await api.deletePipeline(pipelineId);
    if (selectedId === pipelineId) {
      setSelectedId(null);
      setDetail(null);
    }
    await refreshList();
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold tracking-tight">SDLC Agents</h1>
            <p className="text-xs text-slate-400">Phase 1–2 · Planning → Development → Gate 2</p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
                repoConnected
                  ? "bg-sky-950 text-sky-400 border border-sky-800"
                  : "bg-slate-800 text-slate-500 border border-slate-700"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${repoConnected ? "bg-sky-400" : "bg-slate-600"}`} />
              {repoSource === "gitlab" ? "GitLab" : repoSource === "github" ? "GitHub" : "Repo"}{" "}
              {repoConnected ? "connected" : "offline"}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
                jiraConnected
                  ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                  : "bg-slate-800 text-slate-500 border border-slate-700"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${jiraConnected ? "bg-emerald-400" : "bg-slate-600"}`} />
              Jira {jiraConnected ? "live" : "offline"}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {error && (
          <div className="mb-4 rounded-lg bg-red-950/50 border border-red-800 text-red-300 text-sm px-4 py-2">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-slate-500 text-sm">Loading…</p>
        ) : detail ? (
          <PipelineDetail
            pipeline={detail}
            onUpdate={handleUpdate}
            onBack={() => setSelectedId(null)}
            onDelete={handleDelete}
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 space-y-4">
              <JiraTaskList
                pipelines={pipelines}
                onStarted={handleCreated}
              />
              <CreatePipelineForm
                onCreated={handleCreated}
                jiraConnected={jiraConnected}
              />
              <PipelineList
                pipelines={pipelines}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onDelete={handleDelete}
              />
            </div>
            <div className="lg:col-span-2 flex items-center justify-center rounded-xl border border-dashed border-slate-700 text-slate-500 text-sm p-12">
              Pick a live Jira task or pipeline to view agent outputs and manage Gate 1
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
