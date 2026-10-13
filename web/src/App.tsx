import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fileRows, lanes, sessionEvents, touches, type JumpTarget } from './activity.ts';
import { agentColor, buildChat } from './chat.ts';
import { ActivityPanel } from './components/ActivityPanel.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { AuthPage } from './components/AuthPage.tsx';
import { ProjectsPage } from './components/ProjectsPage.tsx';
import { RulesPage } from './components/RulesPage.tsx';
import { lastProject, useRoute } from './route.ts';
import { EventsDrawer } from './components/EventsDrawer.tsx';
import { Frame } from './components/Frame.tsx';
import { isRunning, SubagentPanel } from './components/SubagentPanel.tsx';
import { TimelinePanel } from './components/TimelinePanel.tsx';
import { useNow, type Jump } from './jump.ts';
import { useForge } from './useForge.ts';

/** Signed in, or the sign-in page first. The cockpit only connects once the server will let it. */
export function App() {
  const [auth, setAuth] = useState<{ signedIn: boolean; passwordSet: boolean } | null>(null);
  const check = useCallback(() => {
    fetch('/api/auth').then((r) => r.json()).then(setAuth).catch(() => setTimeout(check, 2000));
  }, []);
  useEffect(check, [check]);
  if (!auth) return null;
  if (!auth.signedIn) return <AuthPage passwordSet={auth.passwordSet} onSignedIn={check} />;
  return <Cockpit onSignedOut={check} />;
}

function Cockpit({ onSignedOut }: { onSignedOut: () => void }) {
  const route = useRoute();
  // The URL's project, else the one you last had open; null lets the server pick its default.
  const [wanted, setWanted] = useState<string | null>(route.project ?? lastProject.get());
  useEffect(() => {
    if (route.project) setWanted(route.project);
  }, [route.project]);
  const [state, send] = useForge(wanted, onSignedOut);
  const view = route.view;
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const jumps = useRef(0);
  const [showEvents, setShowEvents] = useState(false);

  // A project opened: remember it, and drop selections that belonged to the last one.
  const openProject = state.session?.projectName ?? null;
  // The tab says which project, and how many approvals wait, so a background tab still gets your attention.
  useEffect(() => {
    document.title = `${state.approvals.length ? `(${state.approvals.length}) ` : ''}${openProject ? `${openProject} · ` : ''}Forge AIOS`;
  }, [openProject, state.approvals.length]);
  useEffect(() => {
    if (!openProject) return;
    lastProject.set(openProject);
    setSelected(null);
    setSelectedFile(null);
    setJump(null);
  }, [openProject]);
  const now = useNow(5_000);

  const items = useMemo(() => buildChat(state.events), [state.events]);
  const colorOf = useCallback(
    (agentId: string | undefined) => {
      const i = state.agents.findIndex((a) => a.agentId === agentId);
      return i === -1 ? undefined : agentColor(i);
    },
    [state.agents],
  );
  // The main session is always gold; an unknown agent is steel.
  const colorFor = useCallback((agentId: string | null | undefined) => (agentId ? (colorOf(agentId) ?? 'var(--steel)') : 'var(--agent-gold)'), [colorOf]);
  const nameOf = useCallback(
    (agentId: string | null) => (agentId ? (state.agents.find((a) => a.agentId === agentId)?.description ?? 'Subagent') : 'Claude'),
    [state.agents],
  );
  const decide = (id: string, decision: 'allow' | 'deny' | 'allow-session', note?: string) => send({ type: 'decide', id, decision, note });
  const newSession = (model: string, name: string) => send({ type: 'reset', model, name });

  // The activity view covers the current session: files touched, the git diff, and a lane per agent.
  const project = state.session?.project ?? '';
  const current = useMemo(() => sessionEvents(state.events), [state.events]);
  const rows = useMemo(() => fileRows(touches(current, project), state.git, now), [current, project, state.git, now]);
  const timeline = useMemo(() => lanes(current, state.agents, project), [current, state.agents, project]);
  const from = current.length ? Date.parse(current[0].ts) : now;
  // While anything works, the timeline runs to now; once idle it ends at the last event, so the session keeps its width.
  const lastAt = current.length ? Date.parse(current.at(-1)!.ts) : now;
  const live = !!state.session?.busy || state.agents.some(isRunning);
  const timelineEnd = live ? Math.max(now, lastAt) : lastAt;

  /** Linking: jump the chat (or a subagent's feed, opening its card) to the moment clicked. */
  const onJump = (target: JumpTarget) => {
    if (target.scope) setSelected(target.scope);
    setJump({ ...target, n: ++jumps.current });
  };

  return (
    <Frame
      session={state.session}
      connected={state.connected}
      pendingApprovals={state.approvals.length}
      runningAgents={state.agents.filter(isRunning).length}
      onInterrupt={() => send({ type: 'interrupt' })}
      view={view}
      projects={state.projects}
    >
      {view === 'projects' && <ProjectsPage projects={state.projects} current={openProject} result={state.projectResult} send={send} onSignedOut={onSignedOut} />}
      {view === 'rules' && state.session && <RulesPage session={state.session} agents={state.agents} allowRules={state.rules} send={send} />}
      <div className="cockpit-grid" hidden={view !== 'cockpit'}>
        <ActivityPanel
          rows={rows}
          git={state.git}
          selectedAgent={selected}
          selectedFile={selectedFile}
          colorOf={colorFor}
          nameOf={nameOf}
          onSelectFile={setSelectedFile}
          onJump={onJump}
        />
        <ChatPanel
          items={items}
          live={state.live}
          session={state.session}
          connected={state.connected}
          agents={state.agents}
          pending={state.approvals}
          colorOf={colorOf}
          onSend={(text) => send({ type: 'send', text })}
          onDecide={decide}
          onNewSession={newSession}
          onName={(name) => send({ type: 'nameSession', name })}
          onSelectAgent={setSelected}
          jump={jump}
        />
        <div className="cockpit-side">
          <SubagentPanel
            session={state.session}
            agents={state.agents}
            events={state.events}
            pending={state.approvals}
            selected={selected}
            colorOf={colorOf}
            nameOf={nameOf}
            onDecide={decide}
            onSelect={setSelected}
            onSteer={(agentId, text) => send({ type: 'steer', agentId, text })}
            onStop={(agentId) => send({ type: 'stop', agentId })}
            onAdd={(request) => send({ type: 'addAgent', request })}
            onLimit={(maxRunning) => send({ type: 'config', maxRunning })}
            onClose={(agentId) => send({ type: 'closeAgent', agentId })}
            jump={jump}
          />
          <button className="fa-link cockpit-side__link" onClick={() => setShowEvents(true)}>Raw events</button>
        </div>
        <TimelinePanel lanes={timeline} from={from} to={timelineEnd} selectedAgent={selected} selectedFile={selectedFile} colorOf={colorFor} onJump={onJump} />
      </div>
      {showEvents && <EventsDrawer events={state.events} onClose={() => setShowEvents(false)} />}
    </Frame>
  );
}
