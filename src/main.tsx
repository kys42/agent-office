import React from 'react';
import ReactDOM from 'react-dom/client';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './styles/fonts.css';
import App from './App';
import { DeskDock } from './components/DeskDock';
import { DockCard } from './components/DockCard';
import { bootLocale, useI18n } from './lib/i18n';
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
    return this.state.failed ? <Crashed /> : this.props.children;
  }
}
function Crashed() {
  const { t } = useI18n();
  return (
    <div className="empty-state">
      <h1>{t.common.crash.title}</h1>
      <p>{t.common.crash.body}</p>
      <button className="button primary" onClick={() => location.reload()}>
        {t.common.crash.reload}
      </button>
    </div>
  );
}
bootLocale();
// Same office core, three presentations: the big office window, the floating desk pet, and
// the colleague card the pet opens at a desk.
const dock = location.hash.startsWith('#mini');
const card = location.hash === '#card';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <Boundary>{card ? <DockCard /> : dock ? <DeskDock /> : <App />}</Boundary>,
);
