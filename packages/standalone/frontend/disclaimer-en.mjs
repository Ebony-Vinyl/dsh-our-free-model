import { DISCLAIMER_VERSION } from '../../../src/disclaimer.js'

/** English copy for the console's language toggle; the plugin's own settings page stays Chinese. */
export const DISCLAIMER_EN = Object.freeze({
  version: DISCLAIMER_VERSION,
  title: 'Usage notes and disclaimer',
  subtitle: 'The channels this plugin does not offer, and the limits of responsibility you should know about',
  intro: 'This plugin is a personal learning and technical-research project for studying model gateways, protocol adaptation and local routing. It is provided "as is" and is not a commercial service or product commitment.',
  sections: Object.freeze([
    {
      id: 'excluded',
      heading: 'These three channels are not provided',
      body: 'This plugin neither bundles nor offers WorkBuddy China (workbuddy, also known as CodeBuddy), WorkBuddy International (workbuddy-ai), or Huawei Cloud MaaS (huaweicloud, including Token Plan). All three are removed on both the plugin and desktop sides: they never appear in the channel list, presets, sign-in entry points, plugin marketplace, or model catalog, and they cannot be enabled by importing a configuration or installing a third-party plugin. Their absence from the catalog is not a fault but a deliberate decision by this project; future updates will not reintroduce them.',
    },
    {
      id: 'responsibility',
      heading: 'Third-party channel use is not our concern',
      body: 'If you use those channels or any other third-party service outside this plugin in any way — including configuring your own endpoints, importing credentials, installing third-party software, or signing in to someone else\'s account — that is your own action, unrelated to this project\'s author and team. We do not participate in, endorse, or support it, and we accept no responsibility for its availability, compliance, or any consequences.',
    },
    {
      id: 'accounts',
      heading: 'You are responsible for your accounts and credentials',
      body: 'This plugin stores only the credentials you actively import, on your own machine, and never uploads them to any server. Make sure your use of these accounts complies with the corresponding provider\'s terms and your local laws; any bans, charges, data risks, or other losses arising from that use are borne by you.',
    },
    {
      id: 'no-warranty',
      heading: 'No warranty of any kind',
      body: 'This project makes no express or implied warranty of correctness, stability, merchantability, or fitness for a particular purpose. The author and team accept no liability for any direct or indirect loss caused by using this plugin. Assess the risks yourself, and prioritize compliance with the laws of your jurisdiction and the provider agreements.',
    },
    {
      id: 'lawful',
      heading: 'Use it lawfully',
      body: 'This project is for personal learning and technical research only. Do not use it to violate a provider\'s terms, circumvent authorization limits, abuse quotas at scale, or for any other unlawful purpose. Any dispute, claim, or legal liability arising from improper use is borne by the user.',
    },
  ]),
  accept: 'I have read and understood',
  reopen: 'View disclaimer',
})
