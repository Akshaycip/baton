import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { proxy: { '/local': 'http://localhost:8787', '/api': 'http://localhost:8787', '/rpc': 'http://localhost:8787', '/config.json': 'http://localhost:8787' } },
});
