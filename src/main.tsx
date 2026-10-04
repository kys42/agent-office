import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/do-hyeon/korean-400.css';
import '@fontsource/ibm-plex-sans-kr/korean-400.css';
import '@fontsource/ibm-plex-sans-kr/korean-500.css';
import '@fontsource/ibm-plex-sans-kr/korean-600.css';
import '@fontsource/ibm-plex-sans-kr/korean-700.css';
import App from './App';
import './styles.css';
import './office-scene.css';
import './conversation-news.css';
import './resident-life.css';
import './usage-life.css';
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
        <button onClick={() => location.reload()}>다시 열기</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <Boundary>
    <App />
  </Boundary>,
);
