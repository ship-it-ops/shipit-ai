// Thin re-export. The canonical loader lives in @shipit-ai/shared so every
// service reads the same YAML files with the same schema.
export { loadConfig, type Config } from '@shipit-ai/shared';
