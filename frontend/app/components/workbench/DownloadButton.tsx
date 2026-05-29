import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { PanelHeaderButton } from '~/components/ui/PanelHeaderButton';
import { workbenchStore } from '~/lib/stores/workbench';
import { downloadProjectAsZip } from '~/utils/download';

interface DownloadButtonProps {
  className?: string;
}

export function DownloadButton({ className }: DownloadButtonProps) {
  const files = useStore(workbenchStore.files);

  const handleDownload = async () => {
    try {
      await downloadProjectAsZip(files);
      toast.success('Project downloaded successfully!');
    } catch (error) {
      console.error('Failed to download project:', error);
      toast.error('Failed to download project');
    }
  };

  return (
    <PanelHeaderButton
      className={className}
      onClick={handleDownload}
      title="Download project as ZIP"
    >
      <div className="i-ph:download" />
    </PanelHeaderButton>
  );
}
