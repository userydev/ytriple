import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests/ui',timeout:60000,workers:1,reporter:'list',outputDir:'test-results/ui',use:{trace:'retain-on-failure'}});
