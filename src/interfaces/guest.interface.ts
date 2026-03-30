export interface Guest {
    _id: string,
    session_uuid: string,
    metadata?: Record<string, any>,
    createdAt: Date,
    updatedAt: Date,
};
