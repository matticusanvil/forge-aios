import { useState } from 'react';
import { MODELS, type AddAgentRequest } from '../../../shared/types.ts';

type Props = {
  agentTypes: string[];
  /** Set when the running-agents limit is reached: the form explains instead of starting. */
  atLimit: number | null;
  onStart: (request: AddAgentRequest) => void;
  onCancel: () => void;
};

const MODES: { id: AddAgentRequest['mode']; label: string; hint: string }[] = [
  { id: 'worker', label: 'Works on its own', hint: 'Its own Claude process in this project. You talk to it directly; the main session doesn’t know about it.' },
  { id: 'main', label: 'Reports to main', hint: 'The main session launches it with exactly these settings and gets its report. It starts at main’s next step.' },
];

/** Add agent: name, model, task, and whether it works on its own or reports to the main session. */
export function AddAgentForm({ agentTypes, atLimit, onStart, onCancel }: Props) {
  const [mode, setMode] = useState<AddAgentRequest['mode']>('worker');
  const [name, setName] = useState('');
  const [model, setModel] = useState('sonnet');
  const [agentType, setAgentType] = useState('general-purpose');
  const [task, setTask] = useState('');
  const types = agentTypes.length ? agentTypes : ['general-purpose'];
  const ready = !!task.trim() && atLimit === null;

  return (
    <form
      className="cockpit-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onStart({ name: name.trim() || 'Agent', model, task: task.trim(), mode, ...(mode === 'main' && { agentType }) });
      }}
    >
      <div className="cockpit-add__modes" role="radiogroup" aria-label="How it works">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            className={`fa-btn fa-btn--sm${mode === m.id ? '' : ' fa-btn--secondary'}`}
            onClick={() => {
              setMode(m.id);
              if (m.id === 'worker' && !model) setModel('sonnet');
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="fa-field__hint">{MODES.find((m) => m.id === mode)!.hint}</p>

      <label className="fa-field">
        <span className="fa-field__label">Name</span>
        <input className="fa-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="reviewer" maxLength={60} />
      </label>
      <div className="cockpit-add__row">
        <label className="fa-field">
          <span className="fa-field__label">Model</span>
          <select className="fa-input" value={model} onChange={(e) => setModel(e.target.value)}>
            {mode === 'main' && <option value="">Same as main</option>}
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        {mode === 'main' && (
          <label className="fa-field">
            <span className="fa-field__label">Type</span>
            <select className="fa-input" value={agentType} onChange={(e) => setAgentType(e.target.value)}>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        )}
      </div>
      <label className="fa-field">
        <span className="fa-field__label">Task</span>
        <textarea className="fa-input cockpit-add__task" value={task} onChange={(e) => setTask(e.target.value)} rows={4} placeholder="What should it do?" />
      </label>

      {atLimit !== null && (
        <p className="fa-msg fa-msg--warning">
          <span className="fa-msg__cap">Limit</span>
          <span className="fa-msg__body">{atLimit} agent{atLimit === 1 ? ' is' : 's are'} running, the most you allow. Raise the limit or wait.</span>
        </p>
      )}
      <div className="fa-approval__actions">
        <button className="fa-btn" disabled={!ready}>Start</button>
        <button type="button" className="fa-link" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
