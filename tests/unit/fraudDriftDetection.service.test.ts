import {
  FraudDriftDetectionService,
  chiSquaredTest,
  kolmogorovSmirnovTest,
  populationStabilityIndex,
} from '../../src/services/fraudDriftDetection.service';

const make = (count: number, value: number, label: 0 | 1 = 0) => Array.from({ length: count }, () => ({ timestamp: new Date(), label, numeric: { velocity: value }, categorical: { country: value > 5 ? 'NG' : 'US' } }));

describe('FraudDriftDetectionService', () => {
  const service = new FraudDriftDetectionService({ minSamples: 20, methods: ['ks', 'psi', 'chiSquared'], significanceLevel: 0.01, psiThreshold: 0.2 });

  it('detects numeric distribution shifts with KS and PSI', () => {
    expect(kolmogorovSmirnovTest(make(50, 0).map(x => x.numeric!.velocity!), make(50, 10).map(x => x.numeric!.velocity!)).pValue).toBeLessThan(0.01);
    expect(populationStabilityIndex([50, 0], [0, 50])).toBeGreaterThan(0.2);
  });

  it('detects categorical and label drift, and classifies real drift', () => {
    expect(chiSquaredTest([50, 50], [95, 5]).pValue).toBeLessThan(0.01);
    const baseline = service.establishBaseline([...make(50, 0, 0), ...make(50, 1, 0)]);
    const report = service.detect(baseline, make(100, 10, 1));
    expect(report.driftType).toBe('REAL');
    expect(report.recommendedAction).toBe('ALERT');
    expect(service.shouldTriggerRecalibration(report)).toBe(false);
  });

  it('handles sparse features and recommends recalibration for virtual drift', () => {
    const baseline = service.establishBaseline(make(100, 0, 0));
    const report = service.detect(baseline, make(100, 10, 0));
    expect(report.driftType).toBe('VIRTUAL');
    expect(service.shouldTriggerRecalibration(report)).toBe(true);
    expect(service.detectFeatureDrift(baseline, [{ timestamp: new Date(), numeric: {} }])).toEqual([]);
  });

  it('classifies drift deterministically without depending on prior detections', () => {
    const baseline = service.establishBaseline(make(80, 0, 0));
    const first = service.detect(baseline, make(80, 10, 0));
    const second = service.detect(baseline, make(80, 10, 0));

    expect(first.driftType).toBe('VIRTUAL');
    expect(second.driftType).toBe('VIRTUAL');
    expect(first.driftPattern).toBe(second.driftPattern);
  });
});