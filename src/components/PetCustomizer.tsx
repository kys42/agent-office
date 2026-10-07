import { useI18n } from '../lib/i18n';
import { useState } from 'react';
import { Check, RotateCcw, Sparkles } from 'lucide-react';
import type { Mood, Provider, Preferences, Session } from '../shared/types';
import { MOODS, PROVIDERS } from '../shared/types';
import {
  PET_CHARACTERS,
  PET_COLORS,
  PET_ACCESSORIES,
  petKey,
  petLook,
  type PetLook,
  type PetCustomization,
  type PetCharacter,
  type PetColor,
  type PetAccessory,
} from '../shared/pets';
import { usePetAppearance } from './PetAppearanceContext';
import { Modal } from './Modal';
import { Sprite } from './Sprite';

export function PetCustomizer({
  provider,
  session,
  onPrefs,
  onClose,
}: {
  provider: Provider;
  session?: Session;
  onPrefs: (patch: Partial<Preferences>) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const p = t.pets;
  const saved = usePetAppearance();
  const [draft, setDraft] = useState<PetLook>(() => petLook(provider, saved, session));
  const [mood, setMood] = useState<Mood>('idle');
  const [walking, setWalking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (reset = false) => {
    setBusy(true);
    setError('');
    const petAppearance: PetCustomization = {
      version: 1,
      providers: session ? {} : { [provider]: reset ? null : draft },
      colleagues: session ? { [petKey(session)]: reset ? null : draft } : {},
    };
    try {
      if (await onPrefs({ petAppearance })) onClose();
      else setError(p.saveError);
    } catch {
      setError(p.saveError);
    } finally {
      setBusy(false);
    }
  };
  const character = PET_CHARACTERS[draft.character];
  return (
    <Modal
      title={session ? p.individualTitle : p.providerTitle(PROVIDERS[provider].short)}
      onClose={onClose}
      wide
    >
      <div className="pet-customizer">
        <div className="pet-preview">
          <span className="eyebrow">Meet your little colleague</span>
          <div className="pet-preview-stage">
            <span className="pet-preview-spark spark-one">✦</span>
            <span className="pet-preview-spark spark-two">✧</span>
            <Sprite
              provider={provider}
              appearance={draft}
              mood={mood}
              walking={walking}
              size={160}
            />
            <span className="pet-preview-shadow" />
          </div>
          <h3>{character.name}</h3>
          <p>{character.description}</p>
          <div className="pet-preview-moods" role="group" aria-label={p.preview}>
            {(['idle', 'work', 'think', 'call', 'done', 'error', 'sleep', 'leave'] as const).map(
              (state) => (
                <button
                  key={state}
                  aria-pressed={!walking && mood === state}
                  onClick={() => {
                    setWalking(false);
                    setMood(state);
                  }}
                >
                  {MOODS[state].label}
                </button>
              ),
            )}
            <button aria-pressed={walking} onClick={() => setWalking(true)}>
              {p.walk}
            </button>
          </div>
          <div className="pet-scope-note">
            <Sparkles size={14} />
            <span>
              {session
                ? session.actor
                  ? p.actorScope
                  : p.sessionScope
                : p.providerScope(PROVIDERS[provider].short)}
            </span>
          </div>
        </div>
        <div className="pet-options">
          <fieldset disabled={busy}>
            <legend>
              01 <b>{p.chooseCharacter}</b>
            </legend>
            <div className="pet-character-grid">
              {(Object.entries(PET_CHARACTERS) as [PetCharacter, typeof character][]).map(
                ([id, info]) => (
                  <button
                    key={id}
                    className={`pet-character ${draft.character === id ? 'selected' : ''}`}
                    aria-label={p.characterLabel(info.name)}
                    aria-pressed={draft.character === id}
                    onClick={() => setDraft({ ...draft, character: id })}
                  >
                    {info.kind === 'new' && <span className="pet-new">NEW</span>}
                    {draft.character === id && <Check size={13} className="pet-check" />}
                    <Sprite
                      provider={provider}
                      size={64}
                      appearance={{ ...draft, character: id, accessory: 'none' }}
                    />
                    <b>{info.name}</b>
                  </button>
                ),
              )}
            </div>
          </fieldset>
          <fieldset disabled={busy}>
            <legend>
              02 <b>{p.chooseColor}</b>
            </legend>
            <div className="pet-color-grid">
              {(Object.entries(PET_COLORS) as [PetColor, (typeof PET_COLORS)[PetColor]][]).map(
                ([id, color]) => (
                  <button
                    key={id}
                    aria-label={p.colorLabel(color.name)}
                    aria-pressed={draft.color === id}
                    onClick={() => setDraft({ ...draft, color: id })}
                  >
                    <span style={{ background: color.swatch }}>
                      {draft.color === id && <Check size={13} />}
                    </span>
                    {color.name}
                  </button>
                ),
              )}
            </div>
          </fieldset>
          <fieldset disabled={busy}>
            <legend>
              03 <b>{p.chooseAccessory}</b>
            </legend>
            <div className="pet-accessory-grid">
              {(Object.entries(PET_ACCESSORIES) as [PetAccessory, string][]).map(([id, name]) => (
                <button
                  key={id}
                  aria-label={p.accessoryLabel(name)}
                  aria-pressed={draft.accessory === id}
                  onClick={() => setDraft({ ...draft, accessory: id })}
                >
                  <Sprite provider={provider} size={44} appearance={{ ...draft, accessory: id }} />
                  <span>{name}</span>
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </div>
      <div className="pet-customizer-footer">
        <button className="button subtle" disabled={busy} onClick={() => void save(true)}>
          <RotateCcw size={14} />
          {session ? p.resetColleague : p.resetProvider}
        </button>
        <span className="pet-save-error" role="status">
          {error}
        </span>
        <button className="button subtle" disabled={busy} onClick={onClose}>
          {p.cancel}
        </button>
        <button className="button primary" disabled={busy} onClick={() => void save()}>
          {busy ? p.saving : p.save}
        </button>
      </div>
    </Modal>
  );
}
