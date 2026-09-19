import _ from 'lodash';

export const a = (value: unknown): unknown => _.cloneDeep(value);
