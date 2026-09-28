'use strict';

const { worldDistance, campusDistance, calculateDistance } = require('../../server/distance');
const { ROUND_TYPE } = require('../../server/constants');

describe('worldDistance()', () => {

  test('returns zero distance for identical coordinates', () => {
    const coord = { lat: 48.8584, lng: 2.2945 };
    const result = worldDistance(coord, coord);
    expect(result.raw).toBe(0);
    expect(result.normalised).toBe(0);
    expect(result.display).toBe('0 m');
  });

  test('calculates correct distance between Paris and London (~340km)', () => {
    const paris  = { lat: 48.8584, lng: 2.2945 };
    const london = { lat: 51.5074, lng: -0.1278 };
    const result = worldDistance(paris, london);
    expect(result.raw).toBeGreaterThan(300);
    expect(result.raw).toBeLessThan(380);
  });

  test('calculates correct distance between opposite sides of Earth', () => {
    const p1 = { lat: 0,  lng: 0   };
    const p2 = { lat: 0,  lng: 180 };
    const result = worldDistance(p1, p2);
    // Should be close to half Earth's circumference (~20015km)
    expect(result.raw).toBeGreaterThan(19000);
    expect(result.normalised).toBeCloseTo(1, 1);
  });

  test('normalised value is always between 0 and 1', () => {
    const p1 = { lat: -89, lng: -179 };
    const p2 = { lat:  89, lng:  179 };
    const result = worldDistance(p1, p2);
    expect(result.normalised).toBeGreaterThanOrEqual(0);
    expect(result.normalised).toBeLessThanOrEqual(1);
  });

  test('display formats metres for distances under 1km', () => {
    const p1 = { lat: 48.8584, lng: 2.2945 };
    const p2 = { lat: 48.8590, lng: 2.2950 };
    const result = worldDistance(p1, p2);
    expect(result.display).toMatch(/m$/);
  });

  test('display formats km for distances over 1km', () => {
    const paris  = { lat: 48.8584, lng: 2.2945  };
    const berlin = { lat: 52.5200, lng: 13.4050 };
    const result = worldDistance(paris, berlin);
    expect(result.display).toMatch(/km$/);
  });

  test('throws TypeError for invalid lat (out of range)', () => {
    expect(() => worldDistance({ lat: 91, lng: 0 }, { lat: 0, lng: 0 }))
      .toThrow(TypeError);
  });

  test('throws TypeError for invalid lng (out of range)', () => {
    expect(() => worldDistance({ lat: 0, lng: 181 }, { lat: 0, lng: 0 }))
      .toThrow(TypeError);
  });

  test('throws TypeError for NaN coordinates', () => {
    expect(() => worldDistance({ lat: NaN, lng: 0 }, { lat: 0, lng: 0 }))
      .toThrow(TypeError);
  });

  test('throws TypeError for missing fields', () => {
    expect(() => worldDistance({ lat: 48 }, { lat: 0, lng: 0 }))
      .toThrow(TypeError);
  });

  test('throws TypeError for null input', () => {
    expect(() => worldDistance(null, { lat: 0, lng: 0 }))
      .toThrow(TypeError);
  });
});

describe('campusDistance()', () => {

  test('returns zero for identical pixel coordinates', () => {
    const coord = { x: 0.5, y: 0.5 };
    const result = campusDistance(coord, coord);
    expect(result.raw).toBe(0);
    expect(result.normalised).toBe(0);
  });

  test('calculates correct diagonal distance (0,0) to (1,1)', () => {
    const result = campusDistance({ x: 0, y: 0 }, { x: 1, y: 1 });
    // Euclidean distance of unit square diagonal = √2 ≈ 1.414
    expect(result.raw).toBeCloseTo(Math.SQRT2, 4);
    expect(result.normalised).toBeCloseTo(1, 4);
  });

  test('normalised is always between 0 and 1', () => {
    const result = campusDistance({ x: 0, y: 0 }, { x: 1, y: 1 });
    expect(result.normalised).toBeLessThanOrEqual(1);
    expect(result.normalised).toBeGreaterThanOrEqual(0);
  });

  test('calculates horizontal distance correctly', () => {
    const result = campusDistance({ x: 0, y: 0.5 }, { x: 1, y: 0.5 });
    expect(result.raw).toBeCloseTo(1, 4);
  });

  test('calculates vertical distance correctly', () => {
    const result = campusDistance({ x: 0.5, y: 0 }, { x: 0.5, y: 1 });
    expect(result.raw).toBeCloseTo(1, 4);
  });

  test('display says "Spot on!" for zero distance', () => {
    const result = campusDistance({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 });
    expect(result.display).toBe('Spot on!');
  });

  test('throws TypeError for coordinates outside [0,1]', () => {
    expect(() => campusDistance({ x: 1.5, y: 0 }, { x: 0, y: 0 }))
      .toThrow(TypeError);
  });

  test('throws TypeError for negative coordinates', () => {
    expect(() => campusDistance({ x: -0.1, y: 0 }, { x: 0, y: 0 }))
      .toThrow(TypeError);
  });

  test('throws TypeError for null input', () => {
    expect(() => campusDistance(null, { x: 0, y: 0 }))
      .toThrow(TypeError);
  });
});

describe('calculateDistance()', () => {

  test('dispatches to worldDistance for ROUND_TYPE.WORLD', () => {
    const result = calculateDistance(
      ROUND_TYPE.WORLD,
      { lat: 48.8584, lng: 2.2945 },
      { lat: 48.8584, lng: 2.2945 }
    );
    expect(result.raw).toBe(0);
  });

  test('dispatches to campusDistance for ROUND_TYPE.CAMPUS', () => {
    const result = calculateDistance(
      ROUND_TYPE.CAMPUS,
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 }
    );
    expect(result.raw).toBe(0);
  });

  test('throws TypeError for unknown round type', () => {
    expect(() => calculateDistance('invalid', { lat: 0, lng: 0 }, { lat: 0, lng: 0 }))
      .toThrow(TypeError);
  });
});