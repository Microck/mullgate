'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { type ComponentProps, useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

type MullvadThemeSwitchProps = ComponentProps<'div'> & {
  mode?: 'light-dark' | 'light-dark-system';
};

const themeOptions = [
  {
    icon: Sun,
    key: 'light',
    label: 'Light',
  },
  {
    icon: Moon,
    key: 'dark',
    label: 'Dark',
  },
] as const;

export function MullvadThemeSwitch({ className, mode: _mode, ...props }: MullvadThemeSwitchProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const activeTheme = mounted ? resolvedTheme : 'light';

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-fd-border bg-fd-card/90 p-1 shadow-[0_10px_30px_rgba(25,46,69,0.08)] backdrop-blur',
        className,
      )}
      {...props}
    >
      {themeOptions.map(({ icon: Icon, key, label }) => {
        const isActive = activeTheme === key;

        return (
          <button
            key={key}
            type="button"
            aria-label={`Switch to ${label.toLowerCase()} mode`}
            className={cn(
              'inline-flex size-8 items-center justify-center rounded-full border border-transparent text-fd-muted-foreground transition-colors',
              isActive && 'border-fd-primary/20 bg-fd-primary text-fd-primary-foreground shadow-sm',
              !isActive && 'hover:bg-fd-accent hover:text-fd-accent-foreground',
            )}
            onClick={() => {
              setTheme(key);
            }}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
