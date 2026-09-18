import { Button } from '@/components/Button';
import { format } from '~utils/format';
import { store } from '#lib/store';
import { store as rootStore } from '/src/lib/store';
import { store as baseStore } from 'src/lib/store';
import { App } from './app/App';
import { tool } from '../packages/app/tool';
import React from 'react';
import { ghost } from './missing';
import { nope } from '@/does-not-exist';

export const main = [Button, format, store, rootStore, baseStore, App, tool, React, ghost, nope];
