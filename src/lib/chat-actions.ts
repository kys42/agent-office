import { api } from './api';
import { parseArtifact } from '../shared/office';
import { browserChatActions, type ChatActions } from '../components/chat/actions';

/** Desktop-specific dispatch stays outside the reusable message components. */
export const desktopChatActions: ChatActions = {
  copyText: browserChatActions.copyText,
  openLink: async (url) => {
    if (parseArtifact(url)) await api.openArtifact(url);
    else await api.openLink?.(url);
  },
};
