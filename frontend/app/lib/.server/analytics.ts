const NAMESPACE = 'BedrockVibe';

interface MetricDef {
  name: string;
  unit?: 'Count' | 'Milliseconds' | 'None';
}

export function emitMetric(
  metrics: Record<string, number>,
  dimensions: Record<string, string>,
) {
  const metricDefs: MetricDef[] = Object.keys(metrics).map((name) => ({
    name,
    unit: 'Count',
  }));

  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [Object.keys(dimensions)],
          Metrics: metricDefs.map((m) => ({ Name: m.name, Unit: m.unit })),
        },
      ],
    },
    ...dimensions,
    ...metrics,
  };

  console.log(JSON.stringify(emf));
}
