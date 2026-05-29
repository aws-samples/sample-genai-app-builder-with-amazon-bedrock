import { useStore } from '@nanostores/react';
import { memo } from 'react';
import { templateSettingsStore } from '~/lib/stores/templateSettings';
import { classNames } from '~/utils/classNames';

export const TemplateToggle = memo(() => {
  const enableTemplate = useStore(templateSettingsStore.enableTemplate);
  
  const handleToggle = () => {
    templateSettingsStore.toggleEnableTemplate();
  };
  
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center">
        <div className="relative group mr-2">
          <div className="w-4 h-4 rounded-full border border-bolt-elements-textSecondary flex items-center justify-center cursor-help text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:border-bolt-elements-textPrimary">
            ?
          </div>
          <div className="absolute left-1/2 top-full mt-2 w-64 p-2 bg-bolt-elements-backgroundDefault border border-bolt-elements-borderColor rounded-md shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-10 text-xs text-bolt-elements-textSecondary transform -translate-x-1/2">
            This is recommended to ensure the project can be deployed using the react-starter-pack CDK stack.
          </div>
        </div>
        <span className="text-sm text-bolt-elements-textSecondary">Enable GenAIIC Template</span>
      </div>
      <button
        onClick={handleToggle}
        className={classNames(
          'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-bolt-elements-focus focus:ring-offset-2',
          {
            'bg-green-500': enableTemplate,
            'bg-red-500': !enableTemplate,
          }
        )}
        role="switch"
        aria-checked={enableTemplate}
      >
        <span
          className={classNames(
            'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
            {
              'translate-x-6': enableTemplate,
              'translate-x-1': !enableTemplate,
            }
          )}
        />
      </button>
    </div>
  );
});
