import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 요소를 찾지 못했습니다.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
