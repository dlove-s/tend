import { useCallback, useEffect, useRef, useState } from "react";
import { api, post } from "../app/api";
import type { Inspector, WorkspaceTab } from "../app/types";
import type { SourceRecipe, ThreadBinding, VoiceTarget, WorkspaceRevision, WorkspaceView } from "../types";

interface FeedWorkspaceView {
  policy: string;
  sources: Array<SourceRecipe & { content: string; checkpoint: string }>;
  prompts: Array<{ name: string; content: string }>;
  thread: ThreadBinding;
}

interface GlobalWorkspaceView {
  globalPolicy: string;
  prompts: Array<{ name: string; content: string }>;
}

function WorkspaceEditor({
  label,
  content,
  onFocus,
  onSave,
  onUndo,
}: {
  label: string;
  content: string;
  onFocus: () => void;
  onSave: (content: string) => Promise<WorkspaceRevision>;
  onUndo: (revisionId: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState(content);
  const [saving, setSaving] = useState(false);
  const [undoRevision, setUndoRevision] = useState<string | null>(null);
  useEffect(() => setValue(content), [content]);
  const changed = value.trimEnd() !== content.trimEnd();
  return (
    <section className="workspace-editor">
      <div className="workspace-editor-head">
        <h3>{label}</h3>
        <div className="workspace-editor-actions">
          {undoRevision && <button aria-label={`Undo last save for ${label}`} className="button text" onClick={() => void (async () => {
            setSaving(true);
            try {
              await onUndo(undoRevision);
              setUndoRevision(null);
            } catch {
              // The workspace surfaces the API error in its toast.
            } finally {
              setSaving(false);
            }
          })()}>Undo last save</button>}
          <button aria-label={`Save ${label}`} className="button ghost" disabled={!changed || saving} onClick={() => void (async () => {
            setSaving(true);
            try {
              const revision = await onSave(value);
              setUndoRevision(revision.id);
            } catch {
              // The workspace surfaces the API error in its toast.
            } finally {
              setSaving(false);
            }
          })()}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
      <textarea aria-label={label} value={value} onFocus={onFocus} onClick={onFocus} onChange={(event) => setValue(event.target.value)} rows={Math.max(7, Math.min(20, value.split("\n").length + 2))} />
    </section>
  );
}

function ThreadSetupGuide({
  feedId,
  feedName,
  thread,
  onCopied,
}: {
  feedId: string;
  feedName: string;
  thread: ThreadBinding;
  onCopied: (message: string) => void;
}) {
  if (thread.agents?.claude) return null;
  const command = `tend setup claude --feed ${feedId}`;
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      onCopied("Claude setup command copied");
    } catch {
      onCopied("Could not copy automatically. Select the command and copy it manually.");
    }
  };
  return (
    <div className="thread-onboarding">
      <div className="panel-kicker">Claude-native setup</div>
      <h3>Arm a Claude session for {feedName}.</h3>
      <p>Tend is intended to stay open in a Claude session's in-app browser preview. That same session reviews the feed here and drains its queued work.</p>
      <ol>
        <li>Keep this feed open in a Claude session's in-app browser preview.</li>
        <li>Run the setup command from your Tend install and paste its output into that session — or just run <code>/tend</code> to arm the session.</li>
        <li>Let the session bind its Claude lane and start the wake monitor before using the feed actions.</li>
      </ol>
      <div className="thread-setup-command">
        <code>{command}</code>
        <button type="button" className="button ghost" aria-label={`Copy Claude setup command for ${feedName}`} onClick={() => void copyCommand()}>Copy command</button>
      </div>
      <p className="thread-command-note">From an unpacked release, use <code>./tend</code>. From source, use <code>pnpm tend --</code> before <code>setup claude --feed {feedId}</code>.</p>
      <p className="thread-manual-wake"><strong>Manual activation:</strong> open or wake that Claude session and say <code>go deal with the feed</code> for the first run or whenever you want an immediate sweep.</p>
    </div>
  );
}

export function PromptWorkspace({ state, refreshVersion, tab, onTab, onBack, onInspector, onSaved, onTargetFocus }: { state: WorkspaceView; refreshVersion: number; tab: WorkspaceTab; onTab: (tab: WorkspaceTab) => void; onBack: () => void; onInspector: (value: Inspector) => void; onSaved: (message: string) => void; onTargetFocus: (target: VoiceTarget) => void }) {
  const [feedWorkspace, setFeedWorkspace] = useState<FeedWorkspaceView | null>(null);
  const [globalWorkspace, setGlobalWorkspace] = useState<GlobalWorkspaceView | null>(null);
  const feedRequest = useRef(0);
  const globalRequest = useRef(0);
  const feedId = state.active.config.id;
  const reloadFeed = useCallback(async () => {
    const request = ++feedRequest.current;
    const workspace = await api<FeedWorkspaceView>(`/api/feeds/${feedId}/how`);
    if (request === feedRequest.current) setFeedWorkspace(workspace);
  }, [feedId]);
  const reloadGlobal = useCallback(async () => {
    const request = ++globalRequest.current;
    const workspace = await api<GlobalWorkspaceView>("/api/global-prompts");
    if (request === globalRequest.current) setGlobalWorkspace(workspace);
  }, []);
  useEffect(() => {
    setFeedWorkspace(null);
    return () => { feedRequest.current += 1; };
  }, [feedId]);
  useEffect(() => { void reloadFeed(); }, [reloadFeed, refreshVersion]);
  useEffect(() => {
    if (tab === "global") void reloadGlobal();
    return () => { globalRequest.current += 1; };
  }, [reloadGlobal, tab]);
  const save = async <T,>(callback: () => Promise<T>, message: string, reload: () => Promise<void>): Promise<T> => {
    try {
      const result = await callback();
      await reload();
      onSaved(message);
      return result;
    } catch (error) {
      onSaved(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  return (
    <main className="workspace-page">
      <button className="workspace-back" onClick={onBack}>← Back to feed</button>
      <div className="workspace-title">
        <div>
          <div className="panel-kicker">Prompts & sources</div>
          <h1>{tab === "feed" ? `${state.active.config.name} setup` : "Global prompts"}</h1>
        </div>
        {tab === "feed" && <button className="button ghost" onClick={() => onInspector("add-source")}>＋ Add a source</button>}
      </div>
      <nav className="workspace-tabs">
        <button className={tab === "feed" ? "active" : ""} onClick={() => onTab("feed")}>This feed</button>
        <button className={tab === "global" ? "active" : ""} onClick={() => onTab("global")}>Global prompts</button>
      </nav>
      {tab === "feed" ? !feedWorkspace ? <p>Loading feed setup…</p> : (
        <div className="workspace-stack">
          <WorkspaceEditor label="Feed policy" content={feedWorkspace.policy} onFocus={() => onTargetFocus({ kind: "feed", feedId })} onSave={(content) => save(() => post(`/api/feeds/${feedId}/policy`, { content }), "Feed policy saved", reloadFeed)} onUndo={(revisionId) => save(() => post(`/api/revisions/${revisionId}/revert`), "Feed policy restored", reloadFeed)} />
          <section className="workspace-section">
            <div className="workspace-section-head"><h2>Source recipes</h2><span>{feedWorkspace.sources.length}</span></div>
            {feedWorkspace.sources.map((source: any) => <WorkspaceEditor key={source.id} label={source.name} content={source.content} onFocus={() => onTargetFocus({ kind: "source_recipe", feedId, sourceId: source.id })} onSave={(content) => save(() => post(`/api/feeds/${feedId}/sources/${encodeURIComponent(source.id)}`, { content }), "Source recipe saved", reloadFeed)} onUndo={(revisionId) => save(() => post(`/api/revisions/${revisionId}/revert`), "Source recipe restored", reloadFeed)} />)}
          </section>
          <section className="workspace-section">
            <div className="workspace-section-head"><h2>Prompt layers</h2><span>{feedWorkspace.prompts.length}</span></div>
            {feedWorkspace.prompts.map((prompt: any) => <WorkspaceEditor key={prompt.name} label={prompt.name} content={prompt.content} onFocus={() => onTargetFocus({ kind: "prompt_layer", feedId, promptId: prompt.name })} onSave={(content) => save(() => post(`/api/feeds/${feedId}/prompts/${encodeURIComponent(prompt.name)}`, { content }), "Feed prompt saved", reloadFeed)} onUndo={(revisionId) => save(() => post(`/api/revisions/${revisionId}/revert`), "Feed prompt restored", reloadFeed)} />)}
          </section>
          <section className="workspace-section">
            <h2>Agent lane</h2>
            <ThreadSetupGuide feedId={feedId} feedName={state.active.config.name} thread={feedWorkspace.thread} onCopied={onSaved} />
            <div className="thread-status">
              <div><span>Drain agent</span><strong>{feedWorkspace.thread.drainAgent ?? "codex"}</strong></div>
              <div><span>Claude lane</span><strong>{feedWorkspace.thread.agents?.claude?.threadId ?? "Not bound"}</strong></div>
              <div><span>Bound</span><strong>{feedWorkspace.thread.agents?.claude?.boundAt ? new Date(feedWorkspace.thread.agents.claude.boundAt).toLocaleString() : feedWorkspace.thread.boundAt ? new Date(feedWorkspace.thread.boundAt).toLocaleString() : "Not yet"}</strong></div>
              <div><span>Codex thread</span><strong>{feedWorkspace.thread.homeThreadId ?? "Not bound"}</strong></div>
            </div>
          </section>
        </div>
      ) : !globalWorkspace ? <p>Loading global prompts…</p> : (
        <div className="workspace-stack">
          <WorkspaceEditor label="Global policy" content={globalWorkspace.globalPolicy} onFocus={() => onTargetFocus({ kind: "attention" })} onSave={(content) => save(() => post("/api/global-policy", { feedId, content }), "Global policy saved", reloadGlobal)} onUndo={(revisionId) => save(() => post(`/api/revisions/${revisionId}/revert`), "Global policy restored", reloadGlobal)} />
          <section className="workspace-section">
            <div className="workspace-section-head"><h2>Prompt layers</h2><span>{globalWorkspace.prompts.length}</span></div>
            {globalWorkspace.prompts.map((prompt: any) => <WorkspaceEditor key={prompt.name} label={prompt.name} content={prompt.content} onFocus={() => onTargetFocus({ kind: "global_prompt", promptId: prompt.name })} onSave={(content) => save(() => post(`/api/global-prompts/${encodeURIComponent(prompt.name)}`, { feedId, content }), "Global prompt saved", reloadGlobal)} onUndo={(revisionId) => save(() => post(`/api/revisions/${revisionId}/revert`), "Global prompt restored", reloadGlobal)} />)}
          </section>
        </div>
      )}
    </main>
  );
}
