import type { FormHTMLAttributes, TextareaHTMLAttributes, Ref } from 'react';

/** Controlled input only. Each host owns drafts, permissions, receipts and submission. */
export function ChatComposer({
  text,
  onTextChange,
  onSend,
  sendDisabled = false,
  submitKey = 'enter',
  field,
  fieldRef,
  children,
  ...form
}: Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> & {
  text: string;
  onTextChange(text: string): void;
  onSend(): void;
  sendDisabled?: boolean;
  submitKey?: 'enter' | 'modifier-enter';
  field?: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'onKeyDown'>;
  fieldRef?: Ref<HTMLTextAreaElement>;
}) {
  const submit = () => {
    if (!sendDisabled && text.trim()) onSend();
  };
  return (
    <form
      {...form}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        {...field}
        ref={fieldRef}
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={(event) => {
          const wantsSend =
            submitKey === 'enter' ? !event.shiftKey : event.metaKey || event.ctrlKey;
          if (
            event.key === 'Enter' &&
            wantsSend &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229
          ) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {children}
    </form>
  );
}
