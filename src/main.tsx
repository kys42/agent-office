import React from 'react';
import ReactDOM from 'react-dom/client';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './styles/fonts.css';
import App from './App';
import { DeskDock } from './components/DeskDock';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/office.css';
import './styles/panel.css';
import './styles/pages.css';
import './styles/ux.css';
import './styles/usage.css';
import './styles/dock.css';
import './styles/veil.css';
import './styles/speech.css';
import './styles/effects.css';
class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="empty-state">
        <h1>사무실을 다시 열어볼까요?</h1>
        <p>표시 중 문제가 생겼어요. 원본 세션은 안전하게 보관되어 있어요.</p>
        <button className="button primary" onClick={() => location.reload()}>
          다시 열기
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
// Same office core, two presentations: the big office window or the floating desk pet.
const dock = location.hash.startsWith('#mini');
ReactDOM.createRoot(document.getElementById('root')!).render(
  <Boundary>{dock ? <DeskDock /> : <App />}</Boundary>,
);
