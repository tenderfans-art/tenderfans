export type Venue = {
  id: string;
  slug: string;
  name: string;
  city: string;
  state: string;
  address: string;
  type: string;
  cheers: number;
  claimed: boolean;
  heroImage?: string;
  streetViewAvailable?: boolean;
  googlePlaceId?: string;
  lat?: number;
  lng?: number;
  bio?: string;
};

export type Bartender = {
  id: string;
  slug: string;
  name: string;
  venueSlug: string;
  venueName: string;
  city: string;
  venues?: {
    slug: string;
    name: string;
    city: string;
    isPrimary: boolean;
  }[];
  cheers: number;
  claimed: boolean;
  photo?: string;
  bio?: string;
  tags: string[];
};

export const venues: Venue[] = [
  { id: "v1", slug: "harbor-room-st-pete", name: "Harbor Room", city: "St. Petersburg", state: "FL", address: "101 Central Ave, St. Petersburg, FL", type: "Cocktail Bar", cheers: 1284, claimed: true, heroImage: "https://images.unsplash.com/photo-1514933651103-005eec06c04b?auto=format&fit=crop&w=1400&q=80", bio: "Neighborhood cocktails, warm service and a bar team that remembers your order." },
  { id: "v2", slug: "the-local-st-pete", name: "The Local", city: "St. Petersburg", state: "FL", address: "220 1st Ave N, St. Petersburg, FL", type: "Neighborhood Bar", cheers: 786, claimed: false, streetViewAvailable: true, googlePlaceId: "mock-place-2", lat: 27.772, lng: -82.638 },
  { id: "v3", slug: "sunset-taproom", name: "Sunset Taproom", city: "St. Petersburg", state: "FL", address: "540 Beach Dr NE, St. Petersburg, FL", type: "Taproom", cheers: 541, claimed: false, streetViewAvailable: false, googlePlaceId: "mock-place-3", lat: 27.777, lng: -82.632 }
];

export const bartenders: Bartender[] = [
  { id: "b1", slug: "mia-r-101", name: "Mia R.", venueSlug: "harbor-room-st-pete", venueName: "Harbor Room", city: "St. Petersburg", cheers: 684, claimed: true, photo: "https://images.unsplash.com/photo-1577219491135-ce391730fb2c?auto=format&fit=crop&w=700&q=80", bio: "Cocktail nerd, hospitality lifer and believer that the best drink is the one you actually want to drink.", tags: ["Makes everyone feel welcome", "Great recommendations", "Cocktail knowledge"] },
  { id: "b2", slug: "ashley-m-227", name: "Ashley M.", venueSlug: "the-local-st-pete", venueName: "The Local", city: "St. Petersburg", cheers: 427, claimed: false, tags: ["Fast when it’s packed", "Friendly", "Remembers regulars"] },
  { id: "b3", slug: "mike-r-308", name: "Mike R.", venueSlug: "sunset-taproom", venueName: "Sunset Taproom", city: "St. Petersburg", cheers: 318, claimed: false, tags: ["Beer knowledge", "Great energy", "Neighborhood favorite"] }
];

export const bartenderTraits = [
  "Makes everyone feel welcome",
  "Great recommendations",
  "Fast when it’s packed",
  "Knows the classics",
  "Creative drinks",
  "Remembers regulars",
  "Great energy",
  "Cocktail knowledge",
  "Beer knowledge",
  "Whiskey knowledge",
  "Friendly",
  "Neighborhood favorite"
];
