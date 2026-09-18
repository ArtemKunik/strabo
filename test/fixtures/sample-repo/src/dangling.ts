import './styles.css';
import { gone } from './does-not-exist.ts';
import external from 'some-external-package';

export const dangling = [gone, external];
