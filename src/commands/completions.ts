import type { Command } from 'commander';

import { type WritableTextSink, writeCliRaw } from '../cli-output.js';

type CompletionShell = 'bash' | 'zsh' | 'fish';

type CompletionsCommandDependencies = {
  readonly stdout?: WritableTextSink;
};

const TOP_LEVEL_COMMANDS = ['setup', 'proxy', 'config', 'version', 'completions'] as const;
const TOP_LEVEL_FLAGS = ['-h', '--help', '-v', '--version'] as const;
const PROXY_SUBCOMMANDS = [
  'start',
  'stop',
  'restart',
  'status',
  'logs',
  'doctor',
  'validate',
  'list',
  'export',
  'autostart',
  'access',
  'relay',
] as const;
const CONFIG_SUBCOMMANDS = ['path', 'show', 'get', 'set', 'validate', 'regions', 'hosts'] as const;

export function registerCompletionsCommand(
  program: Command,
  dependencies: CompletionsCommandDependencies = {},
): void {
  program
    .command('completions')
    .description('Generate shell completion scripts for bash, zsh, or fish.')
    .argument('<shell>', 'Target shell: bash, zsh, or fish.')
    .action((shell: string) => {
      const stdout = dependencies.stdout ?? process.stdout;
      const normalized = normalizeShell(shell);
      writeCliRaw({ sink: stdout, text: renderCompletionScript(normalized) });
    });
}

function normalizeShell(raw: string): CompletionShell {
  const normalized = raw.trim().toLowerCase();

  if (normalized === 'bash' || normalized === 'zsh' || normalized === 'fish') {
    return normalized;
  }

  throw new Error(`Unsupported shell ${raw}. Expected bash, zsh, or fish.`);
}

function renderCompletionScript(shell: CompletionShell): string {
  if (shell === 'bash') {
    return renderBashScript();
  }

  if (shell === 'zsh') {
    return renderZshScript();
  }

  return renderFishScript();
}

function renderBashScript(): string {
  return `# Mullgate bash completions
_mullgate_complete() {
  local cur prev words cword
  _init_completion || return

  local top_level="${TOP_LEVEL_COMMANDS.join(' ')}"
  local top_level_flags="${TOP_LEVEL_FLAGS.join(' ')}"
  local proxy_subcommands="${PROXY_SUBCOMMANDS.join(' ')}"
  local config_subcommands="${CONFIG_SUBCOMMANDS.join(' ')}"

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$top_level $top_level_flags" -- "$cur") )
    return
  fi

  case "\${words[1]}" in
    proxy)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "$proxy_subcommands" -- "$cur") )
        return
      fi
      case "\${words[2]}" in
        start) COMPREPLY=( $(compgen -W "--dry-run --help" -- "$cur") ) ;;
        stop) COMPREPLY=( $(compgen -W "--help" -- "$cur") ) ;;
        restart) COMPREPLY=( $(compgen -W "--help" -- "$cur") ) ;;
        status|doctor|validate|list) COMPREPLY=( $(compgen -W "--help" -- "$cur") ) ;;
        logs) COMPREPLY=( $(compgen -W "--tail --follow --help" -- "$cur") ) ;;
        access) COMPREPLY=( $(compgen -W "--mode --access-mode --base-domain --unsafe-public-empty-password --clear-base-domain --route-bind-ip --help" -- "$cur") ) ;;
        export) COMPREPLY=( $(compgen -W "--protocol --country --region --city --server --provider --owner --run-mode --min-port-speed --count --guided --regions --dry-run --stdout --force --output --help" -- "$cur") ) ;;
        relay)
          if [[ $cword -eq 3 ]]; then
            COMPREPLY=( $(compgen -W "list probe verify recommend" -- "$cur") )
            return
          fi
          ;;
      esac
      return
      ;;
    config)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "$config_subcommands" -- "$cur") )
        return
      fi
      ;;
    completions)
      if [[ $cword -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
        return
      fi
      ;;
  esac
}

complete -F _mullgate_complete mullgate
`;
}

function renderZshScript(): string {
  return `#compdef mullgate
autoload -U bashcompinit
bashcompinit
${renderBashScript().replace('complete -F _mullgate_complete mullgate', 'compdef _mullgate_complete mullgate')}`;
}

function renderFishScript(): string {
  const lines = [
    '# Mullgate fish completions',
    ...TOP_LEVEL_COMMANDS.map(
      (command) => `complete -c mullgate -f -n "__fish_use_subcommand" -a "${command}"`,
    ),
    ...TOP_LEVEL_FLAGS.map(
      (flag) =>
        `complete -c mullgate -f -n "__fish_use_subcommand" -l "${flag.replace(/^-+/, '')}"`,
    ),
    ...PROXY_SUBCOMMANDS.map(
      (command) => `complete -c mullgate -f -n "__fish_seen_subcommand_from proxy" -a "${command}"`,
    ),
    `complete -c mullgate -n "__fish_seen_subcommand_from completions" -a "bash zsh fish"`,
    `complete -c mullgate -n "__fish_seen_subcommand_from proxy start" -l dry-run`,
    `complete -c mullgate -n "__fish_seen_subcommand_from proxy logs" -l tail`,
    `complete -c mullgate -n "__fish_seen_subcommand_from proxy logs" -l follow`,
  ];

  return `${lines.join('\n')}\n`;
}
