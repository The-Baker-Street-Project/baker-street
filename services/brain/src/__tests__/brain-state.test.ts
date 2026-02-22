import { describe, it, expect, vi } from 'vitest';
import { BrainStateMachine } from '../brain-state.js';

describe('BrainStateMachine', () => {
  // --- Valid transitions ---

  it('transitions pending -> active via activate()', () => {
    const sm = new BrainStateMachine('pending');
    expect(sm.state).toBe('pending');
    sm.activate();
    expect(sm.state).toBe('active');
  });

  it('transitions active -> draining via drain()', () => {
    const sm = new BrainStateMachine('active');
    sm.drain();
    expect(sm.state).toBe('draining');
  });

  it('transitions active -> shutdown via shutdown()', () => {
    const sm = new BrainStateMachine('active');
    sm.shutdown();
    expect(sm.state).toBe('shutdown');
  });

  it('transitions draining -> shutdown via shutdown()', () => {
    const sm = new BrainStateMachine('active');
    sm.drain();
    expect(sm.state).toBe('draining');
    sm.shutdown();
    expect(sm.state).toBe('shutdown');
  });

  // --- Invalid transitions ---

  it('throws on pending -> draining', () => {
    const sm = new BrainStateMachine('pending');
    expect(() => sm.drain()).toThrow('Invalid state transition: pending -> draining');
  });

  it('throws on pending -> shutdown', () => {
    const sm = new BrainStateMachine('pending');
    expect(() => sm.shutdown()).toThrow('Invalid state transition: pending -> shutdown');
  });

  it('throws on draining -> active', () => {
    const sm = new BrainStateMachine('active');
    sm.drain();
    expect(() => sm.activate()).toThrow('Invalid state transition: draining -> active');
  });

  it('throws on shutdown -> anything', () => {
    const sm = new BrainStateMachine('active');
    sm.shutdown();
    expect(() => sm.activate()).toThrow('Invalid state transition: shutdown -> active');
    expect(() => sm.drain()).toThrow('Invalid state transition: shutdown -> draining');
    expect(() => sm.shutdown()).toThrow('Invalid state transition: shutdown -> shutdown');
  });

  it('throws on active -> active (double activate)', () => {
    const sm = new BrainStateMachine('active');
    expect(() => sm.activate()).toThrow('Invalid state transition: active -> active');
  });

  // --- Event emission ---

  it('emits "active" when transitioning to active', () => {
    const sm = new BrainStateMachine('pending');
    const handler = vi.fn();
    sm.on('active', handler);
    sm.activate();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('emits "draining" when transitioning to draining', () => {
    const sm = new BrainStateMachine('active');
    const handler = vi.fn();
    sm.on('draining', handler);
    sm.drain();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('emits "shutdown" when transitioning to shutdown', () => {
    const sm = new BrainStateMachine('active');
    const handler = vi.fn();
    sm.on('shutdown', handler);
    sm.shutdown();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not emit events on invalid transitions', () => {
    const sm = new BrainStateMachine('pending');
    const handler = vi.fn();
    sm.on('draining', handler);
    expect(() => sm.drain()).toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  // --- isAcceptingRequests / isReady ---

  it('isAcceptingRequests returns true only when active', () => {
    const sm = new BrainStateMachine('pending');
    expect(sm.isAcceptingRequests()).toBe(false);

    sm.activate();
    expect(sm.isAcceptingRequests()).toBe(true);

    sm.drain();
    expect(sm.isAcceptingRequests()).toBe(false);
  });

  it('isReady returns true only when active', () => {
    const sm = new BrainStateMachine('pending');
    expect(sm.isReady()).toBe(false);

    sm.activate();
    expect(sm.isReady()).toBe(true);

    sm.shutdown();
    expect(sm.isReady()).toBe(false);
  });

  it('initializes in the provided state', () => {
    const sm1 = new BrainStateMachine('active');
    expect(sm1.state).toBe('active');
    expect(sm1.isReady()).toBe(true);

    const sm2 = new BrainStateMachine('pending');
    expect(sm2.state).toBe('pending');
    expect(sm2.isReady()).toBe(false);
  });
});
