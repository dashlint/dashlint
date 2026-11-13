import PostHog from 'posthog-react-native';

const posthog = new PostHog('fixture');

export function chapterOpened(chapter: number): void {
  posthog.capture('chapter_opened', { chapter });
}
