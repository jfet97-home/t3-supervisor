// a response whose body a test does not read is cancelled, so its stream does not outlive the test
export const released = async (response: Response): Promise<Response> => {
  await response.body?.cancel();
  return response;
};
