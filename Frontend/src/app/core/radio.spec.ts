import { OfflineSimulator } from './offline-simulator';
import { summarise } from './orion-store.service';

const details = (e: { details: string }) => JSON.parse(e.details) as Record<string, unknown>;

describe('radio log (Demo)', () => {
  const make = () => new OfflineSimulator({ onFleet: () => {}, onLedger: () => {}, onRecommendations: () => {} });
  const flush = (sim: OfflineSimulator) => sim.ledger.append('TEST_FLUSH', null, {});

  it('adds simulated radio chatter shortly after the scripted beats', async () => {
    const sim = make();
    for (let i = 0; i < 2 * 70; i++) sim.advance(0.5); // spoof at 30 s, recommendation at 60 s
    await flush(sim);
    const radio = sim.ledger.events.filter(e => e.event_type === 'RADIO_TRANSMISSION');
    expect(radio.length).toBe(2);
    const [spoof, rec] = radio.map(details);
    expect(spoof['transcript']).toContain('D2 a sărit pe hartă');
    expect(spoof['simulated']).toBeTrue();
    expect(spoof['mission_time_s'] as number).toBeGreaterThanOrEqual(34);
    expect(radio[0].operator_id).toBe('OPERATOR_2');
    expect(rec['transcript']).toContain('recomandarea ORION pentru D2');
    expect(radio[1].operator_id).toBe('TOC');
  });

  it('logs a real transmission at the time the mic was keyed, in the hash chain', async () => {
    const sim = make();
    for (let i = 0; i < 20; i++) sim.advance(0.5); // T+10
    sim.logRadio('Pierd GPS pe D3 și D4.', 'OPERATOR_1', { duration_s: 4, mission_time_s: 6, language: 'ro' });
    await flush(sim);
    const e = sim.ledger.events.find(x => x.event_type === 'RADIO_TRANSMISSION')!;
    expect(e.operator_id).toBe('OPERATOR_1');
    expect(details(e)).toEqual(jasmine.objectContaining({ transcript: 'Pierd GPS pe D3 și D4.', mission_time_s: 6, channel: 'COMMAND_NET' }));
    expect(details(e)['simulated']).toBeUndefined();
    expect(e.prev_hash).toBe(sim.ledger.events[sim.ledger.events.indexOf(e) - 1].curr_hash);
  });

  it('shows transcripts as quotes in the log', () => {
    const e = { id: 1, timestamp: '', event_type: 'RADIO_TRANSMISSION', drone_id: 2, operator_id: 'OPERATOR_2', prev_hash: '', curr_hash: '',
      details: JSON.stringify({ transcript: 'D2 a sărit pe hartă.', simulated: true }) };
    expect(summarise(e)).toBe('Drone 2: „D2 a sărit pe hartă.” (simulated)');
  });

  it('forgets pending chatter on reset', async () => {
    const sim = make();
    for (let i = 0; i < 61; i++) sim.advance(0.5); // spoofed at 30 s, its line is due at 34 s
    sim.reset();
    for (let i = 0; i < 20; i++) sim.advance(0.5);
    await flush(sim);
    expect(sim.ledger.events.some(e => e.event_type === 'RADIO_TRANSMISSION')).toBeFalse();
  });
});
