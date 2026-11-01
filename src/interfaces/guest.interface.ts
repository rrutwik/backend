export interface Guest {
    _id: string,
    session_uuid: string,
    display_name: string,
    metadata?: Record<string, any>,
    /** Server-controlled matchmaking bot (never connects a socket). */
    is_bot?: boolean,
    /** 0..1 chance that a bot plays its best-scored move instead of a random legal one. */
    bot_skill?: number,
    createdAt: Date,
    updatedAt: Date,
};
