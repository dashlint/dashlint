import posthog from 'posthog-js';

// A default export arrow: no name holds it.
export default (event: string): void => {
  posthog.capture(event);
};
