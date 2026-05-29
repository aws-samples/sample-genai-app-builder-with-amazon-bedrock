import { atom, type WritableAtom } from 'nanostores';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('TemplateSettingsStore');

/**
 * Store for application settings
 */
export class TemplateSettingsStore {
  get() {
    return {
      enableTemplate: this.enableTemplate.get()
    };
  }

  // Whether to use the project template when creating new artifacts
  enableTemplate: WritableAtom<boolean> = import.meta.hot?.data.enableTemplate ?? atom(false);

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.enableTemplate = this.enableTemplate;
    }

    // Initialize from localStorage if available
    this.#loadFromLocalStorage();
  }

  /**
   * Toggle the template setting
   */
  toggleEnableTemplate() {
    const currentValue = this.enableTemplate.get();
    this.enableTemplate.set(!currentValue);
    this.#saveToLocalStorage();
    logger.debug(`Template setting toggled to: ${!currentValue}`);
  }

  /**
   * Set the template setting to a specific value
   */
  setEnableTemplate(value: boolean) {
    this.enableTemplate.set(value);
    this.#saveToLocalStorage();
    logger.debug(`Template setting set to: ${value}`);
  }

  /**
   * Load settings from localStorage
   */
  #loadFromLocalStorage() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const storedValue = window.localStorage.getItem('vibe_enable_template');
        if (storedValue !== null) {
          this.enableTemplate.set(storedValue === 'true');
          logger.debug(`Loaded template setting from localStorage: ${storedValue === 'true'}`);
        }
      }
    } catch (error) {
      logger.error('Failed to load settings from localStorage:', error);
    }
  }

  /**
   * Save settings to localStorage
   */
  #saveToLocalStorage() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem('vibe_enable_template', String(this.enableTemplate.get()));
      }
    } catch (error) {
      logger.error('Failed to save settings to localStorage:', error);
    }
  }
}

export const templateSettingsStore = new TemplateSettingsStore();
