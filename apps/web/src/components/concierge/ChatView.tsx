'use client';

import {
  CONTACT_TEAM_LABEL,
  splitClarifyMessage,
  VIP_OFFER_TEXT,
  VIP_REQUEST_TEXT,
} from '@ai-concierge/domain';
import { useEffect, useRef, useState } from 'react';
import { customerStepFor } from '../../lib/customerJourney';
import { formatDateTime } from '../../lib/format';
import { PillButton } from '../ui/PillButton';
import { ProgressBar } from './ProgressBar';
import { QuoteCard } from './QuoteCard';
import { useChatSession } from './useChatSession';

const MAX_LENGTH = 1000;
const SUGGESTIONS = [
  "I'd like to rent a Lamborghini Urus in Dubai Marina from 15 to 19 October",
  'What cars do you have available?',
  'I want to speak to a person',
];

/** The VIP booking choice: the senior team arranges everything personally. */
function VipOffer({ active, onChoose }: { active: boolean; onChoose: () => void }) {
  return (
    <div
      className="mt-3 rounded-xl border border-copper-300/70 bg-copper-500/15 p-3"
      data-testid="vip-offer"
    >
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-copper-100">
        ⭐ VIP booking
      </p>
      <p className="mt-1 text-sm text-cream-50/90">
        Our senior team arranges everything for you personally.
      </p>
      {active && (
        <button
          type="button"
          onClick={onChoose}
          className="mt-2 rounded-pill bg-copper-gradient px-4 py-1.5 text-xs font-semibold text-ink-900"
        >
          Yes, VIP booking
        </button>
      )}
    </div>
  );
}

function TypingBubble() {
  return (
    <li className="flex justify-start" aria-label="The concierge is typing">
      <div className="rounded-2xl border border-white/10 bg-emerald-800/80 px-4 py-3">
        <span className="flex gap-1" aria-hidden="true">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="h-2 w-2 animate-bounce rounded-full bg-cream-50/60"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
      </div>
    </li>
  );
}

/**
 * When the concierge did not understand, its message carries numbered options. They are drawn as
 * highlighted buttons — impossible to miss — and picking one sends that option as the customer's reply.
 */
function ClarifyOptions({
  intro,
  options,
  active,
  onPick,
}: {
  intro: string;
  options: string[];
  active: boolean;
  onPick: (option: string) => void;
}) {
  return (
    <div data-testid="clarify-options">
      {intro && <p className="whitespace-pre-wrap break-words">{intro}</p>}
      <ol className="mt-3 space-y-2" aria-label="Choose one">
        {options.map((option, index) => {
          const isTeam = option === CONTACT_TEAM_LABEL;
          return (
            <li key={option}>
              <button
                type="button"
                disabled={!active}
                onClick={() => onPick(option)}
                className={`flex w-full items-start gap-3 rounded-2xl border-2 px-3 py-2.5 text-left text-sm font-semibold transition-colors disabled:cursor-default ${
                  active
                    ? isTeam
                      ? 'border-copper-300 bg-copper-500/25 text-cream-50 shadow-[0_0_16px_rgba(224,150,90,0.35)] hover:bg-copper-500/40'
                      : 'border-copper-300/90 bg-copper-500/15 text-cream-50 shadow-[0_0_16px_rgba(224,150,90,0.25)] hover:bg-copper-500/30'
                    : 'border-white/10 bg-white/5 text-cream-50/50'
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    active ? 'bg-copper-gradient text-ink-900' : 'bg-white/10 text-cream-50/60'
                  }`}
                >
                  {index + 1}
                </span>
                <span className="pt-0.5">{option}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The customer's chat with the concierge. Everything the customer sees is what
 * the server holds for their session: the AI's replies, a team member's
 * replies (clearly labelled), and their own messages. Unsent or failed messages
 * stay visible with a retry, so nothing typed is ever silently lost.
 */
export function ChatView() {
  const chat = useChatSession();
  const [draft, setDraft] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const step = customerStepFor(chat.session?.journeyState ?? null);
  const quote = chat.session?.quote ?? null;
  const canConfirm = quote !== null && chat.session?.journeyState === 'QUOTE_ISSUED';
  const empty = chat.messages.length === 0 && chat.pending.length === 0;
  // Only the newest message can be answered with its options, and only while nothing else is in flight.
  const lastMessage = chat.messages[chat.messages.length - 1];
  const openOptionsId =
    lastMessage && lastMessage.role !== 'CUSTOMER' && splitClarifyMessage(lastMessage.content)
      ? lastMessage.id
      : null;

  useEffect(() => {
    const box = boxRef.current;
    if (box && followRef.current) box.scrollTop = box.scrollHeight;
  });

  const vipChosen = chat.messages.some(
    (message) => message.role === 'CUSTOMER' && /\bvip\b/i.test(message.content),
  );
  const canChooseVip =
    !vipChosen && !chat.session?.escalated && !chat.sending && chat.pending.length === 0;
  function chooseVip() {
    followRef.current = true;
    chat.send(VIP_REQUEST_TEXT);
  }

  function submit() {
    const text = draft.trim();
    if (!text || chat.sending) return;
    chat.send(text);
    setDraft('');
    followRef.current = true;
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-4rem-env(safe-area-inset-bottom))] max-w-xl flex-col">
      <header className="border-b border-white/10 px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="font-display text-sm uppercase tracking-[0.18em] text-cream-50">
            Concierge
          </h1>
          {canChooseVip && (
            <button
              type="button"
              onClick={chooseVip}
              className="ml-auto rounded-pill border border-copper-300 bg-copper-500/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-copper-100 transition-colors hover:bg-copper-500/30"
              data-testid="vip-header-button"
            >
              ⭐ VIP booking
            </button>
          )}
          <p
            className={`rounded-pill border px-3 py-1 text-[11px] font-medium uppercase tracking-wide ${
              chat.session?.escalated
                ? 'border-copper-300/60 bg-copper-500/15 text-copper-100'
                : 'border-white/15 text-cream-50/70'
            }`}
            data-testid="chat-step"
          >
            {step.label}
          </p>
        </div>
        <ProgressBar state={chat.session?.journeyState ?? null} />
      </header>

      {chat.status === 'offline' && (
        <p className="bg-warning/15 px-4 py-2 text-center text-xs text-warning" role="status">
          You are offline. Reconnect to keep chatting — anything you type will wait here.
        </p>
      )}

      <div
        ref={boxRef}
        onScroll={(event) => {
          const box = event.currentTarget;
          followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {empty && chat.status !== 'loading' && (
          <div className="mx-auto max-w-sm pt-6 text-center">
            <p className="font-display text-base text-cream-50">Hello, how can I help?</p>
            <p className="mt-2 text-sm text-cream-50/70">
              Tell me the car, the dates and where you would like to pick it up — I will take care
              of the rest.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button
                type="button"
                onClick={chooseVip}
                className="rounded-2xl border-2 border-copper-300 bg-copper-500/15 px-4 py-3 text-left text-sm text-cream-50 shadow-[0_0_22px_rgba(224,150,90,0.35)] transition-colors hover:bg-copper-500/25"
                data-testid="vip-start-button"
              >
                <span className="block text-xs font-bold uppercase tracking-[0.14em] text-copper-100">
                  ⭐ VIP booking
                </span>
                Our senior team arranges everything for you personally
              </button>
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => chat.send(suggestion)}
                  className="rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-left text-sm text-cream-50/90 transition-colors hover:bg-emerald-700/40"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        <ol className="space-y-3" aria-live="polite" aria-label="Conversation">
          {chat.messages.map((message) => {
            const mine = message.role === 'CUSTOMER';
            const staff = message.role === 'STAFF';
            const clarify = mine ? null : splitClarifyMessage(message.content);
            return (
              <li key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[86%] rounded-2xl px-4 py-2.5 text-sm ${
                    mine
                      ? 'bg-copper-gradient text-ink-900'
                      : staff
                        ? 'border-2 border-copper-300 bg-emerald-700 text-cream-50 shadow-[0_0_26px_rgba(224,150,90,0.5)]'
                        : 'border border-white/10 bg-emerald-800/80 text-cream-50'
                  }`}
                  data-testid={staff ? 'staff-message' : undefined}
                >
                  {staff && (
                    <p className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-copper-300">
                      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-copper-300" />
                      Team member
                    </p>
                  )}
                  {clarify ? (
                    <ClarifyOptions
                      intro={clarify.intro}
                      options={clarify.options}
                      active={
                        message.id === openOptionsId && chat.pending.length === 0 && !chat.sending
                      }
                      onPick={(option) => {
                        followRef.current = true;
                        chat.send(option);
                      }}
                    />
                  ) : !mine && message.content.includes(VIP_OFFER_TEXT) ? (
                    <>
                      <p className="whitespace-pre-wrap break-words">
                        {message.content.replace(VIP_OFFER_TEXT, '').trim()}
                      </p>
                      <VipOffer
                        active={message.id === lastMessage?.id && canChooseVip}
                        onChoose={chooseVip}
                      />
                    </>
                  ) : (
                    <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  )}
                  {message.attachments.length > 0 && (
                    <ul className="mt-2 grid grid-cols-2 gap-2" aria-label="Photos">
                      {message.attachments.map((attachment) => (
                        <li key={attachment.url}>
                          <a href={attachment.url} target="_blank" rel="noopener noreferrer">
                            {/* Plain <img>: the photo is served by the API, not from this app. */}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={attachment.url}
                              alt={attachment.caption}
                              loading="lazy"
                              className="aspect-[4/3] w-full rounded-xl border border-white/10 object-cover"
                            />
                          </a>
                          <p className="mt-1 text-[10px] text-cream-50/60">{attachment.caption}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p
                    className={`mt-1 text-[10px] ${mine ? 'text-ink-900/60' : 'text-cream-50/40'}`}
                  >
                    {formatDateTime(message.createdAt).split(', ')[1]}
                  </p>
                </div>
              </li>
            );
          })}

          {chat.pending.map((item) => (
            <li key={item.clientMessageId} className="flex justify-end">
              <div className="max-w-[86%] rounded-2xl bg-copper-gradient px-4 py-2.5 text-sm text-ink-900 opacity-80">
                <p className="whitespace-pre-wrap break-words">{item.text}</p>
                {item.failed ? (
                  <button
                    type="button"
                    onClick={() => chat.retry(item.clientMessageId)}
                    className="mt-1 text-[11px] font-semibold underline"
                  >
                    {item.error ?? 'Not sent.'} Tap to retry.
                  </button>
                ) : (
                  <p className="mt-1 text-[10px] text-ink-900/60">Sending…</p>
                )}
              </div>
            </li>
          ))}

          {chat.sending && <TypingBubble />}
        </ol>

        {quote && (
          <div className="mt-4 space-y-3">
            <QuoteCard quote={quote} />
            {canConfirm && (
              <PillButton
                className="w-full"
                disabled={chat.sending}
                onClick={() => chat.send('Yes please, go ahead and book it')}
              >
                Confirm with our team
              </PillButton>
            )}
          </div>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="border-t border-white/10 bg-emerald-900/70 px-3 py-3"
      >
        <label htmlFor="chat-input" className="sr-only">
          Your message
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="chat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value.slice(0, MAX_LENGTH))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            maxLength={MAX_LENGTH}
            placeholder="Message the concierge…"
            enterKeyHint="send"
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-2xl border border-white/10 bg-emerald-900/80 px-4 py-3 text-sm text-cream-50 placeholder:text-cream-50/40 focus:border-copper-300 focus:outline-none"
          />
          <PillButton
            type="submit"
            disabled={!draft.trim() || chat.sending}
            className="h-[44px] px-5 py-0"
          >
            Send
          </PillButton>
        </div>
        {draft.length > MAX_LENGTH - 100 && (
          <p className="mt-1 text-right text-[11px] text-cream-50/50">
            {draft.length} / {MAX_LENGTH}
          </p>
        )}
      </form>
    </div>
  );
}
