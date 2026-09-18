import { format } from '~utils/format';

export function Button(properties: { label: string }): string {
  return format(properties.label);
}
