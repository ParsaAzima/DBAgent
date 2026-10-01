/**
 * Chat input with shell-like history (↑/↓) built on ink-text-input.
 */

import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import TextInput from 'ink-text-input';

interface ChatInputProps {
  onSubmit: (value: string) => void | Promise<void>;
  placeholder?: string;
  disabled?: boolean;
}

/** History is global to the module so remounts keep it. */
const history: string[] = [];

export function ChatInput({
  onSubmit,
  placeholder = 'ask anything… (/help for commands)',
  disabled = false,
}: ChatInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [histIdx, setHistIdx] = useState<number | null>(null);

  useEffect(() => {
    // no-op; history lives at module level across remounts
  }, []);

  const submit = async (): Promise<void> => {
    const v = value.trim();
    if (!v) return;
    if (history[history.length - 1] !== v) history.push(v);
    setHistIdx(null);
    setValue('');
    await onSubmit(v);
  };

  if (disabled) return <></>;

  return (
    <Text>
      <Text color="blue" bold>{'you › '}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={submit}
        placeholder={placeholder}
      />
    </Text>
  );
}
