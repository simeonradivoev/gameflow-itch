export interface ItchListing
{
    id: string;
    itchId?: string;
    pageUrl: string;
    name: string;
    summary?: string;
    author?: string;
    genre?: string;
    coverUrl?: string;
    web: boolean;
}

export interface ItchGame extends ItchListing
{
    embedUrl?: string;
    screenshots: string[];
    genres: string[];
    tags: string[];
    authors: string[];
    updatedAt?: Date;
}
