// Same names, the user's own code: never SDK sites.
const capture = (name: string): string => name;

const shelfLog = {
  screen(name: string): string {
    return name;
  },
};

export function stampCard(): void {
  capture('card_stamped');
  shelfLog.screen('Stamps');
}
