import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // A 股习惯：红涨绿跌
        up: '#ef4444',
        down: '#10b981',
        flat: '#6b7280',
        brand: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#2563eb',
          600: '#1d4ed8',
          700: '#1e40af',
        },
        panel: '#ffffff',
        ink: '#0f172a',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
