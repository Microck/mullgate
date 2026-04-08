'use client';

import { useState } from 'react';

type DemoStep = {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly output: readonly string[];
};

const STEPS: readonly DemoStep[] = [
  {
    id: 'setup',
    label: 'Setup',
    command:
      'mullgate setup --non-interactive --account-number 123456789012 --username alice --password hunter2 --location se-gothenburg',
    output: [
      'Mullgate setup complete.',
      'phase: setup',
      'source: guided-setup',
      'routes: 1',
      'relay cache: ~/.cache/mullgate/relays.json',
      'runtime status: validated',
    ],
  },
  {
    id: 'access',
    label: 'Access',
    command: 'mullgate proxy access --mode private-network --base-domain mullgate.tail',
    output: [
      'Mullgate proxy access updated.',
      'mode: private-network',
      'base domain: mullgate.tail',
      'shared host: 100.64.0.10',
      'dns guidance: publish each saved route hostname to the shared host IP',
    ],
  },
  {
    id: 'start',
    label: 'Start',
    command: 'mullgate proxy start --dry-run',
    output: [
      'Mullgate runtime dry-run complete.',
      'phase: validation',
      'validation: docker/3proxy-startup',
      'docker launch: skipped (--dry-run)',
      'runtime status: validated',
    ],
  },
];

export function TerminalDemo() {
  const [activeId, setActiveId] = useState<string>(STEPS[0].id);
  const activeStep = STEPS.find((step) => step.id === activeId) ?? STEPS[0];

  if (!activeStep) {
    return null;
  }

  return (
    <section className="mt-12 w-full max-w-4xl rounded-2xl border bg-fd-card text-left shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <p className="text-sm font-semibold">Interactive terminal walkthrough</p>
          <p className="text-sm text-fd-muted-foreground">
            Click a step to preview the exact command shape and the operator-facing output.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {STEPS.map((step) => {
            const active = step.id === activeId;

            return (
              <button
                key={step.id}
                type="button"
                onClick={() => setActiveId(step.id)}
                className={[
                  'rounded-md border px-3 py-1.5 text-sm transition',
                  active
                    ? 'border-fd-primary bg-fd-primary text-fd-primary-foreground'
                    : 'border-fd-border bg-fd-background hover:bg-fd-muted',
                ].join(' ')}
              >
                {step.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="overflow-x-auto bg-[#09101a] px-5 py-4 text-sm text-slate-100">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-red-400" />
          <span className="h-3 w-3 rounded-full bg-yellow-400" />
          <span className="h-3 w-3 rounded-full bg-emerald-400" />
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono leading-7">
          <span className="text-emerald-300">$ </span>
          {activeStep.command}
          {'\n'}
          {activeStep.output.join('\n')}
        </pre>
      </div>
    </section>
  );
}
