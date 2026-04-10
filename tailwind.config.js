/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{html,js}", "./public/**/*.{html,js}"],
  safelist: [
    // Mermaid container (built as string in popup.js)
    'mermaid-rendered',
    'my-4', 'p-4', 'bg-white', 'rounded-xl', 'shadow-sm',
    'border', 'border-slate-200', 'overflow-x-auto', 'flex', 'justify-center',
    // Dynamically toggled by setDownloadEnabled()
    'opacity-50', 'shadow-none',
    // Hover/active states on btn-primary (applied via class toggle in JS)
    '-translate-y-0.5', 'scale-95',
  ],
  theme: {
    extend: {
      fontFamily: {
        calistoga: ['Calistoga', 'serif'],
        space:     ['Space Grotesk', 'sans-serif'],
        sans:      ['Inter', 'sans-serif'],
        mono:      ['JetBrains Mono', 'monospace'],
      }
    },
  },
  plugins: [],
}
