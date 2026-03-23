import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { MullvadThemeSwitch } from '@/components/mullvad-theme-switch';

export const gitConfig = {
  user: 'Microck',
  repo: 'mullgate',
  branch: 'main',
  docsContentPath: 'docs/mullgate-docs/content/docs',
};

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'Mullgate',
    },
    links: [
      {
        text: 'Docs',
        url: '/docs',
        active: 'nested-url',
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    slots: {
      themeSwitch: MullvadThemeSwitch,
    },
  };
}
