/**
 * Chat input with shell-like history (↑/↓) built on ink-text-input.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { completeSlashCommand, findSlashCommand, getSlashCommandSuggestions } from './commands.js';

interface ChatInputProps {
  onSubmit: (value: string) => void | Promise<void>;
  placeholder?: string;
  disabled?: boolean;
}

/** Input history is global so remounting the prompt does not discard it. */
const history: string[] = [];

export function ChatInput({
  onSubmit,
  placeholder = 'ask anything… (/help for commands)',
  disabled = false,
}: ChatInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState('');
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [inputRevision, setInputRevision] = useState(0);
  const suggestions = getSlashCommandSuggestions(value);
  const activeSuggestion = suggestions[suggestionIndex % Math.max(suggestions.length, 1)];

  const changeValue = (next: string): void => {
    setValue(next);
    setHistoryIndex(null);
    setSuggestionIndex(0);
  };

  const replaceValue = (next: string): void => {
    changeValue(next);
    setInputRevision((revision) => revision + 1);
  };

  const submit = async (): Promise<void> => {
    const exactCommand = /^\/([^\s]+)$/.exec(value.trim());
    const isKnownCommand = exactCommand && findSlashCommand(exactCommand[1]);
    if (suggestions.length > 0 && !isKnownCommand && activeSuggestion) {
      replaceValue(completeSlashCommand(activeSuggestion));
      return;
    }
    const v = value.trim();
    if (!v) return;
    if (history[history.length - 1] !== v) history.push(v);
    setHistoryIndex(null);
    setValue('');
    await onSubmit(v);
  };

  useInput(
    (input, key) => {
      // ink-text-input filters only ctrl+c, so every other ctrl+letter would
      // insert its bare letter into the prompt (ctrl+t → "t"). Children's
      // input handlers run before this parent-level one, so by the time we
      // get here the stray character is already appended — undo it.
      if (key.ctrl && input.length === 1 && input !== 'c') {
        setValue((v) => (v.length > 0 && v.endsWith(input) ? v.slice(0, -1) : v));
        return;
      }
      if (key.tab && activeSuggestion) {
        replaceValue(completeSlashCommand(activeSuggestion));
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (suggestions.length > 0) {
          const delta = key.downArrow ? 1 : -1;
          setSuggestionIndex((index) => (index + delta + suggestions.length) % suggestions.length);
          return;
        }

        if (history.length === 0) return;
        if (key.upArrow) {
          if (historyIndex === null) {
            setHistoryDraft(value);
            setHistoryIndex(history.length - 1);
            setValue(history[history.length - 1]);
            setInputRevision((revision) => revision + 1);
          } else if (historyIndex > 0) {
            const nextIndex = historyIndex - 1;
            setHistoryIndex(nextIndex);
            setValue(history[nextIndex]);
            setInputRevision((revision) => revision + 1);
          }
        } else if (historyIndex !== null) {
          if (historyIndex < history.length - 1) {
            const nextIndex = historyIndex + 1;
            setHistoryIndex(nextIndex);
            setValue(history[nextIndex]);
            setInputRevision((revision) => revision + 1);
          } else {
            setHistoryIndex(null);
            setValue(historyDraft);
            setInputRevision((revision) => revision + 1);
          }
        }
      }
    },
    { isActive: !disabled },
  );

  if (disabled) return <></>;

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="blue" bold>
          {'you › '}
        </Text>
        <TextInput
          key={inputRevision}
          value={value}
          onChange={changeValue}
          onSubmit={submit}
          placeholder={placeholder}
        />
      </Text>
      {suggestions.length > 0 ? (
        <Box marginLeft={6} flexDirection="column">
          {suggestions.map((command, index) => (
            <Text
              key={command.name}
              color={index === suggestionIndex % suggestions.length ? 'cyan' : 'gray'}
              bold={index === suggestionIndex % suggestions.length}
            >
              {index === suggestionIndex % suggestions.length ? '› ' : '  '}
              <Text>
                /{command.name}
                {command.usage ? ` ${command.usage}` : ''}
              </Text>
              <Text dimColor> {command.description}</Text>
            </Text>
          ))}
          <Text dimColor>↑↓ select · tab complete · enter run</Text>
        </Box>
      ) : null}
    </Box>
  );
}
