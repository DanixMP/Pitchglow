// Web MIDI keyboard input (Phase 19): note on/off from every connected MIDI input, plus the sustain
// pedal (CC 64). Asks the browser for MIDI access the first time it starts (no SysEx).

export interface MidiHandlers {
  onNote(midi: number, down: boolean): void;
  onSustain(down: boolean): void;
  /** Connected input names (empty = none), whenever devices come and go. */
  onDevices(names: string[]): void;
}

export class MidiInput {
  private access: MIDIAccess | null = null;
  private starting: Promise<boolean> | null = null;

  constructor(private readonly handlers: MidiHandlers) {}

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  /** Starts listening (once). Resolves false when MIDI isn't available or was refused. */
  start(): Promise<boolean> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!MidiInput.supported) return false;
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
      } catch {
        this.starting = null; // refused: allow asking again later
        return false;
      }
      this.access.onstatechange = () => this.attach();
      this.attach();
      return true;
    })();
    return this.starting;
  }

  private attach(): void {
    const access = this.access;
    if (!access) return;
    const names: string[] = [];
    access.inputs.forEach((input) => {
      input.onmidimessage = (e) => this.message(e.data);
      if (input.state === 'connected') names.push(input.name || 'MIDI keyboard');
    });
    this.handlers.onDevices(names);
  }

  private message(data: Uint8Array | null): void {
    if (!data || data.length < 3) return;
    const kind = data[0] & 0xf0;
    if (kind === 0x90 && data[2] > 0) this.handlers.onNote(data[1], true);
    else if (kind === 0x80 || (kind === 0x90 && data[2] === 0)) this.handlers.onNote(data[1], false);
    else if (kind === 0xb0 && data[1] === 64) this.handlers.onSustain(data[2] >= 64);
  }
}
