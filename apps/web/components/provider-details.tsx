import { providerFields, type ProviderDetails, type ProviderField } from '@trainerb/contracts';
export function ProviderFacts({ details }: { details: ProviderDetails }) {
  return (
    <dl>
      {(Object.keys(providerFields) as ProviderField[])
        .filter((k) => details[k])
        .map((k) => (
          <div key={k}>
            <dt>{providerFields[k][0]}</dt>
            <dd style={{ overflowWrap: 'anywhere' }}>{details[k]}</dd>
          </div>
        ))}
    </dl>
  );
}
