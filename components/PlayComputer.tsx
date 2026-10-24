import { useState } from 'react';
import { ArrowLeft, Bot } from 'lucide-react';
import type { RuleConfig } from '../lib/game/types.ts';
import { DEFAULT_RULES } from '../lib/game/rules.ts';
import type { Ack } from '../lib/socket/events.ts';
import { GameSettings } from './lobby/GameSettings.tsx';
import { Alert, AlertDescription } from './ui/alert.tsx';
import { Button } from './ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.tsx';
import { Input } from './ui/input.tsx';
import { Label } from './ui/label.tsx';
import { Segmented } from './ui/segmented.tsx';

export function PlayComputer({ onSubmit, onBack, serverReady }: { onSubmit: (nickname: string, bots: number, level: string, rules: RuleConfig) => Promise<Ack<any>>; onBack: () => void; serverReady: boolean }) {
  const [nickname, setNickname] = useState('');
  const [bots, setBots] = useState(1);
  const [level, setLevel] = useState<'easy' | 'normal'>('normal');
  const [rules, setRules] = useState<RuleConfig>({ ...DEFAULT_RULES });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState(false);
  const nameError = nickname.trim().length === 0 ? 'Enter a nickname to continue.' : null;

  const submit = async () => {
    setTouched(true);
    if (nameError) return;
    setLoading(true);
    const r = await onSubmit(nickname.trim(), bots, level, rules);
    setLoading(false);
    if (!r.ok) setError(r.error);
  };

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-6">
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-3">
        <ArrowLeft aria-hidden="true" /> Back
      </Button>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-2xl"><Bot className="size-6 text-gold" aria-hidden="true" /> Play with computer</CardTitle>
          <CardDescription>Start straight away against 1 to 3 computer players.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="cnick">Your nickname</Label>
              <Input id="cnick" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="e.g. Ada" maxLength={16} autoFocus autoComplete="off" aria-invalid={touched && nameError ? true : undefined} />
              {touched && nameError ? <p role="alert" className="text-sm text-red-300">{nameError}</p> : null}
            </div>
            <Segmented label="Computer opponents" value={bots} options={[1, 2, 3].map((n) => ({ value: n, label: String(n) }))} onChange={setBots} />
            <Segmented label="Difficulty" value={level} hint={level === 'easy' ? 'Plays casually and sometimes misses a defence.' : 'Defends, sheds high cards and plans its Whot calls.'} options={[{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }]} onChange={setLevel} />
            <GameSettings rules={rules} maxPlayers={bots + 1} hidePlayers onRules={(p) => setRules((r) => ({ ...r, ...p }))} onMaxPlayers={() => {}} />
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            {!serverReady ? <p role="status" className="text-sm text-muted-foreground">Connecting to the game server… this can take a moment if it was asleep.</p> : null}
            <Button type="submit" size="lg" loading={loading} disabled={!serverReady} className="w-full">
              Start game
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
