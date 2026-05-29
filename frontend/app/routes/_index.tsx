import { json, type MetaFunction } from '@remix-run/node';
import { ClientOnly } from '~/components/ui/ClientOnly';
import { BaseChat } from '~/components/chat/BaseChat';
import { Chat } from '~/components/chat/Chat.client';
import { Header } from '~/components/header/Header';
import GlobalHeader from '~/components/header/GlobalHeader';

export const meta: MetaFunction = () => {
  return [{ title: 'Bedrock Vibe' }, { name: 'description', content: 'Talk with Bedrock Vibe, an AI assistant from the AWS Generative AI Innovation Centre' }];
};

export const loader = () => {
  // console.log('🏠 Index: Loader called');
  return json({});
};

export default function Index() {
  // console.log('🏠 Index: Component rendered');

  return (
    <div className="flex flex-col h-full w-full">
      <GlobalHeader />
      <div className="pt-16"> {/* Add padding to account for fixed header */}
        <Header />
        <ClientOnly fallback={<BaseChat />}>
          {() => <Chat />}
        </ClientOnly>
      </div>
    </div>
  );
}
