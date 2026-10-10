/**
 * Chat input with shell-like history (↑/↓) built on ink-text-input.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  completeSlashCommand,
  findSlashCommand,
  getSlashCommandSuggestions,
  type SlashCommand,
} from './commands.js';
import type { TuiTheme } from './theme.js';

interface ChatInputProps {
  onSubmit: (value: string) => void | Promise<void>;
  placeholder?: string;
  disabled?: boolean;
  /** Dynamic slash entries (installed skills) merged into suggestions. */
  extraCommands?: SlashCommand[];
  theme: TuiTheme;
}

/** Input history is global so remounting the prompt does not discard it. */
const history: string[] = [];

export function ChatInput({
  onSubmit,
  placeholder = 'ask anything… (/help for commands)',
  disabled = false,
  extraCommands = [],
  theme,
}: ChatInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState('');
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [cursorOffset, setCursorOffset] = useState(0);
  const suggestions = getSlashCommandSuggestions(value, extraCommands);
  const activeSuggestion = suggestions[suggestionIndex % Math.max(suggestions.length, 1)];

  const changeValue = (next: string): void => {
    setValue(next);
    setCursorOffset(next.length);
    setHistoryIndex(null);
    setSuggestionIndex(0);
  };

  const replaceValue = (next: string): void => {
    changeValue(next);
  };

  const submit = async (): Promise<void> => {
    const exactCommand = /^\/([^\s]+)$/.exec(value.trim());
    const isKnownCommand = exactCommand && findSlashCommand(exactCommand[1], extraCommands);
    if (suggestions.length > 0 && !isKnownCommand && activeSuggestion) {
      replaceValue(completeSlashCommand(activeSuggestion));
      return;
    }
    const v = value.trim();
    if (!v) return;
    if (history[history.length - 1] !== v) history.push(v);
    setHistoryIndex(null);
    setValue('');
    setCursorOffset(0);
    await onSubmit(v);
  };

  useInput(
    (input, key) => {
      // SGR mouse wheel events must never be inserted into the prompt.
      const mouseInput = input.charCodeAt(0) === 27 ? input.slice(1) : input;
      if (/^\[<\d+;\d+;\d+M$/.test(mouseInput)) return;
      if (key.ctrl || key.meta) {
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
            setCursorOffset(history[history.length - 1].length);
          } else if (historyIndex > 0) {
            const nextIndex = historyIndex - 1;
            setHistoryIndex(nextIndex);
            setValue(history[nextIndex]);
            setCursorOffset(history[nextIndex].length);
          }
        } else if (historyIndex !== null) {
          if (historyIndex < history.length - 1) {
            const nextIndex = historyIndex + 1;
            setHistoryIndex(nextIndex);
            setValue(history[nextIndex]);
            setCursorOffset(history[nextIndex].length);
          } else {
            setHistoryIndex(null);
            setValue(historyDraft);
            setCursorOffset(historyDraft.length);
          }
        }
        return;
      }

      if (key.leftArrow) {
        setCursorOffset((offset) => Math.max(0, offset - 1));
        return;
      }
      if (key.rightArrow) {
        setCursorOffset((offset) => Math.min(value.length, offset + 1));
        return;
      }
      if (key.home) {
        setCursorOffset(0);
        return;
      }
      if (key.end) {
        setCursorOffset(value.length);
        return;
      }
      if (key.backspace) {
        if (cursorOffset > 0) {
          setValue(value.slice(0, cursorOffset - 1) + value.slice(cursorOffset));
          setCursorOffset(cursorOffset - 1);
        }
        return;
      }
      if (key.delete) {
        if (cursorOffset < value.length) {
          setValue(value.slice(0, cursorOffset) + value.slice(cursorOffset + 1));
        }
        return;
      }
      if (key.return) {
        void submit();
        return;
      }
      if (
        input &&
        !Array.from(input).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        })
      ) {
        setValue(value.slice(0, cursorOffset) + input + value.slice(cursorOffset));
        setCursorOffset(cursorOffset + input.length);
        setHistoryIndex(null);
        setSuggestionIndex(0);
      }
    },
    { isActive: !disabled },
  );

  if (disabled) return <></>;
  const cursorBefore = value.slice(0, cursorOffset);
  const cursorChar = value.slice(cursorOffset, cursorOffset + 1) || ' ';
  const cursorAfter = value.slice(cursorOffset + 1);

  return (
    <Box flexDirection="column">
      <Text color={theme.foreground}>
        <Text color={theme.user} bold>
          {'you › '}
        </Text>
        {value.length === 0 ? (
          <>
            <Text inverse> </Text>
            <Text color={theme.muted}>{placeholder}</Text>
          </>
        ) : (
          <>
            {cursorBefore}
            <Text inverse>{cursorChar}</Text>
            {cursorAfter}
          </>
        )}
      </Text>
      {suggestions.length > 0 ? (
        <Box marginLeft={6} flexDirection="column">
          {suggestions.map((command, index) => (
            <Text
              key={command.name}
              color={index === suggestionIndex % suggestions.length ? theme.accent : theme.muted}
              bold={index === suggestionIndex % suggestions.length}
            >
              {index === suggestionIndex % suggestions.length ? '› ' : '  '}
              <Text>
                /{command.name}
                {command.usage ? ` ${command.usage}` : ''}
              </Text>
              <Text color={theme.muted}> {command.description}</Text>
            </Text>
          ))}
          <Text color={theme.muted}>↑↓ select · tab complete · enter run</Text>
        </Box>
      ) : null}
    </Box>
  );
}
