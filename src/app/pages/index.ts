// The tabs, in order. Each page lives in its own file exporting `create<Name>Page(ctx): Page`;
// replacing a page means replacing its file, never this list.
import type { PageFactory } from '../types.ts';
import { createHomePage } from './home.ts';
import { createRunsPage } from './runs.ts';
import { createSettingsPage } from './settings.ts';
import { createModelsPage } from './models.ts';
import { createProvidersPage } from './providers.ts';
import { createMemoryPage } from './memory.ts';
import { createDoctorPage } from './doctor.ts';

export const PAGES: PageFactory[] = [
  createHomePage,
  createRunsPage,
  createSettingsPage,
  createModelsPage,
  createProvidersPage,
  createMemoryPage,
  createDoctorPage,
];
